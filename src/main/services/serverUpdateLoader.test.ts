import assert from "node:assert/strict";
import test from "node:test";
import { serverUpdateLoaderHtml, updateServerBeforeOpening } from "./serverUpdateLoader";

function harness(overrides: { confirmedAfter?: number; install?: () => Promise<{ status: string; message?: string }> } = {}) {
  const said: Array<{ text: string; tone?: string }> = [];
  const log: Array<{ event: string; payload: Record<string, unknown> }> = [];
  let polls = 0;
  let installs = 0;
  const options = {
    ownerConfirmed: () => overrides.confirmedAfter !== undefined && polls >= overrides.confirmedAfter,
    install: () => { installs += 1; return (overrides.install ?? (async () => ({ status: "ready", message: "Your hub is ready." })))(); },
    loader: { status: (text: string, tone?: "info" | "error") => { said.push({ text, tone }); } },
    log: (event: string, payload: Record<string, unknown>) => { log.push({ event, payload }); },
    from: "1.11.3-beta.8",
    to: "1.11.3-beta.9",
    ownerWaitMs: 1_000,
    pollMs: 100,
    noticeMs: 0,
    installCapMs: 200,
    sleep: async () => { polls += 1; }
  };
  return { options, said, log, installs: () => installs };
}

test("the server is updated before the app opens once it confirms this desktop is its owner", async () => {
  const h = harness({ confirmedAfter: 3 });
  assert.equal(await updateServerBeforeOpening(h.options), "updated");
  assert.equal(h.installs(), 1);
  assert.deepEqual(h.said.map((item) => item.text), ["Connecting to your server…", "Updating the program on your server…"]);
  assert.deepEqual(h.log.map((item) => item.event), ["hub.program-update.start", "hub.program-update.finished"]);
});

test("a server that does not answer is not updated, and the loader says it will be later", async () => {
  const h = harness();
  assert.equal(await updateServerBeforeOpening(h.options), "unconfirmed");
  assert.equal(h.installs(), 0, "only a server that confirmed its owner is replaced");
  assert.deepEqual(h.said.at(-1), { text: "Your server did not answer. It will be updated later.", tone: "error" });
});

test("a failed update opens the app with the reason, and a thrown one counts as failed", async () => {
  const refused = harness({ confirmedAfter: 0, install: async () => ({ status: "failed", message: "SSH said no" }) });
  assert.equal(await updateServerBeforeOpening(refused.options), "failed");
  assert.equal(refused.said.at(-1)?.text, "Your server could not be updated: SSH said no. AccordAgents will try again later.");
  const thrown = harness({ confirmedAfter: 0, install: async () => { throw new Error("No server is set up yet."); } });
  assert.equal(await updateServerBeforeOpening(thrown.options), "failed");
  assert.equal(thrown.said.at(-1)?.tone, "error");
});

test("an update that takes too long goes on behind the opened app", async () => {
  const h = harness({ confirmedAfter: 0, install: () => new Promise(() => undefined) });
  assert.equal(await updateServerBeforeOpening(h.options), "timed-out");
  assert.equal(h.said.at(-1)?.text, "Your server is taking long to update. It finishes while AccordAgents is open.");
});

test("the loader page allows nothing but its own picture and style", () => {
  const html = serverUpdateLoaderHtml("data:image/png;base64,AAAA");
  assert.match(html, /default-src 'none'; img-src data:; style-src 'unsafe-inline'/);
  assert.match(html, /Updating your server/);
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(serverUpdateLoaderHtml(undefined), /<img/);
});
