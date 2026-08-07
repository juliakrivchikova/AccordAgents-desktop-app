import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

test("mobile shell builds static installable PWA assets", async () => {
  await execFileAsync(process.execPath, ["scripts/build-mobile-shell.mjs"], {
    cwd: repoRoot
  });

  const manifest = JSON.parse(await readFile(path.join(repoRoot, "dist/mobile/manifest.webmanifest"), "utf8"));
  const worker = await readFile(path.join(repoRoot, "dist/mobile/service-worker.js"), "utf8");
  const app = await readFile(path.join(repoRoot, "dist/mobile/mobile-app.js"), "utf8");
  const icon = await stat(path.join(repoRoot, "dist/mobile/assets/accordagents-mark.png"));

  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, ".");
  assert.equal(manifest.icons[0].src, "assets/accordagents-mark.png");
  assert.ok(icon.size > 0);
  for (const asset of ["./index.html", "./mobile-app.css", "./mobile-app.js", "./manifest.webmanifest"]) {
    assert.match(worker, new RegExp(asset.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")));
  }
  assert.match(app, /indexedDB\.open\(DB_NAME, DB_VERSION\)/);
  assert.match(app, /eventId !== entry\.eventId/);
  assert.match(app, /globalThis\.AccordAgentsMobile/);
});
