// W-H: runs scripts/mailbox-contract-suite.mjs against BOTH implementations —
// the Node reference server and the real Cloudflare worker under `wrangler
// dev` — so a divergence between them fails here instead of in production.
//
// This suite gates every worker deploy. Each later area adds its cases to
// mailbox-contract-suite.mjs, not to this file.
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

import { CONTRACT_CASES, CONTRACT_TTL_MS } from "./mailbox-contract-suite.mjs";

const require = createRequire(import.meta.url);
const { createReferenceMailboxServer } = require("./mailbox-reference-server.cjs");

const repoRoot = path.resolve(import.meta.dirname, "..");
const wranglerConfig = path.join(repoRoot, "cloudflare/relay/wrangler.jsonc");
const RUN_WORKER = process.env.ACCORD_CONTRACT_SKIP_WORKER !== "1";

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function startReference() {
  const port = await freePort();
  const mailbox = createReferenceMailboxServer({ locked: true, eventTtlMs: CONTRACT_TTL_MS });
  const server = mailbox.server ?? mailbox;
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    kind: "reference",
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => new Promise((resolve) => server.close(resolve))
  };
}

async function startWorker() {
  const port = await freePort();
  const persistTo = await mkdtemp(path.join(tmpdir(), "accordagents-contract-worker-"));
  const child = spawn("npx", [
    "wrangler", "dev",
    "--config", wranglerConfig,
    "--ip", "127.0.0.1",
    "--port", String(port),
    "--local",
    "--persist-to", persistTo,
    "--log-level", "error",
    "--var", `ACCORD_MAILBOX_EVENT_TTL_MS:${CONTRACT_TTL_MS}`,
    "--show-interactive-dev-session", "false"
  ], { cwd: repoRoot, env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });

  const output = [];
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));

  const baseUrl = `http://127.0.0.1:${port}`;
  const close = async () => {
    child.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(5000)]);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    await rm(persistTo, { recursive: true, force: true });
  };

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`wrangler dev exited early:\n${output.join("")}`);
    }
    try {
      const health = await fetch(`${baseUrl}/healthz`, { cache: "no-store" });
      if (health.ok) {
        return { kind: "worker", baseUrl, close };
      }
    } catch {
      // not listening yet
    }
    await delay(250);
  }
  await close();
  throw new Error(`wrangler dev did not become ready:\n${output.join("")}`);
}

// One wrangler process for the whole worker pass: booting it per case would
// dominate the run and, worse, hide state that only survives within one
// Durable Object lifetime.
for (const [label, start] of [["reference", startReference], ["worker", startWorker]]) {
  if (label === "worker" && !RUN_WORKER) {
    test("real worker mailbox contract", { skip: "ACCORD_CONTRACT_SKIP_WORKER=1" }, () => {});
    continue;
  }
  test(`${label} mailbox contract`, async (t) => {
    const target = await start();
    try {
      for (const contractCase of CONTRACT_CASES) {
        await t.test(contractCase.name, async () => {
          await contractCase.run(target);
        });
      }
    } finally {
      await target.close();
    }
  });
}
