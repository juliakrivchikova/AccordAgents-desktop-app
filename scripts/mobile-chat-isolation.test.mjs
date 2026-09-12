// Browser regression for chat switching and delivery into the PWA's real IDB.
// This deliberately delays an IDB read, not application code: a render that
// started for A must never replace B after the user navigates away.
// Supporting browser evidence only; this is not an installed-iPhone check.
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { attach } = require("./cdp.cjs");
const { loadMobileOriginHeaders, mobileOriginHeadersForPath } = require("./mobile-origin-headers.cjs");
const root = path.resolve(import.meta.dirname, "../dist/mobile");
const chromeBin = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const event = (id, content) => ({ id, messageId: id, role: "participant", participantLabel: "Drew", content,
  status: "done", createdAt: "2026-09-11T22:00:00.000Z" });
const batch = (conversationId, events) => ({ type: "mobile.timeline.events", conversationId, events });
const chats = ["A", "B"].map(id => ({ id, title: "Chat " + id, group: "QA", participants: ["Drew"], updatedAt: "2026-09-11T22:00:00.000Z" }));

test("the PWA keeps persisted and rendered messages in their own chat", { timeout: 60_000 }, async t => {
  const headers = loadMobileOriginHeaders(root);
  const site = createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const relative = pathname === "/" ? "/index.html" : pathname;
    try {
      const body = await readFile(path.join(root, relative));
      res.writeHead(200, { "content-type": types[path.extname(relative)] || "application/octet-stream",
        ...mobileOriginHeadersForPath(headers, relative) });
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => site.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${site.address().port}`;
  const profile = await mkdtemp(path.join(tmpdir(), "aa-chat-isolation-"));
  const chrome = spawn(chromeBin, ["--headless=new", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=430,860", origin], { stdio: "ignore" });
  let app;
  try {
    for (let i = 0; i < 60 && !app; i++) {
      try {
        const port = Number((await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]);
        app = await attach({ port, title: "AccordAgents" });
      } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.ok(app, "Chrome did not expose the PWA");
    const evaluate = async code => (await app.evaluate(code)).result.value;
    const until = async expression => evaluate(`new Promise((resolve, reject) => {
      const end = Date.now() + 5000;
      function check() {
        if (${expression}) return resolve(true);
        if (Date.now() > end) return reject(new Error(${JSON.stringify("Timed out: " )} + ${JSON.stringify(expression)}));
        setTimeout(check, 10);
      }
      check();
    })`);
    const ingest = payload => evaluate(`AccordAgentsMobile.handleRelayTimelinePayload(${JSON.stringify(payload)})`);
    const select = async id => {
      await app.click("#back-to-chats");
      await until(`document.querySelector("#chats-screen").classList.contains("is-active")`);
      await evaluate(`Array.from(document.querySelectorAll(".mobile-chat-row")).find(row => row.textContent.includes(${JSON.stringify("Chat " + id)})).click()`);
    };
    const shown = () => evaluate(`({ title: document.getElementById("chat-title").textContent,
      body: document.getElementById("message-list").textContent })`);
    await until("Boolean(globalThis.AccordAgentsMobile)");
    await evaluate(`(() => {
      AccordAgentsMobile.savePairing({ endpoint: ${JSON.stringify(origin)}, pairedAt: new Date().toISOString() });
      AccordAgentsMobile.handleRelayChatListPayload({ type: "mobile.chat-list", chats: ${JSON.stringify(chats)} });
    })()`);
    await ingest(batch("A", [event("a", "ONLY_CHAT_A")]));
    await ingest(batch("B", [event("b", "ONLY_CHAT_B")]));
    await select("A");
    await until('document.getElementById("message-list").textContent.includes("ONLY_CHAT_A")');

    // A completed IDB transaction may resolve the read's data later than
    // another render. Hold only one readonly timeline request; writes, the
    // database contents, and every later read retain their normal behavior.
    const holdRead = () => evaluate(`(() => {
      const original = IDBObjectStore.prototype.getAll;
      window.heldRead = { ready: false };
      IDBObjectStore.prototype.getAll = function (...args) {
        const request = original.apply(this, args);
        if (this.name !== "timeline" || this.transaction.mode !== "readonly") return request;
        IDBObjectStore.prototype.getAll = original;
        const held = window.heldRead;
        const proxy = { get result() { return request.result; }, get error() { return request.error; } };
        request.onsuccess = event => {
          held.release = () => { proxy.onsuccess?.(event); held.released = true; };
          held.fail = () => {
            Object.defineProperty(proxy, "error", { value: new DOMException("QA read failed", "UnknownError") });
            proxy.onerror?.(event);
          };
          held.ready = true;
        };
        request.onerror = event => proxy.onerror?.(event);
        return proxy;
      };
    })()`);

    await t.test("late reads cannot replace the newly selected chat", async () => {
      await holdRead();
      await evaluate(`window.oldRender = AccordAgentsMobile.handleRelayTimelinePayload(${JSON.stringify(batch("A", [event("a", "ONLY_CHAT_A updated")]))}); void 0`);
      await until("window.heldRead.ready");
      await select("B");
      await until('document.getElementById("message-list").textContent.includes("ONLY_CHAT_B")');
      await evaluate("window.heldRead.release(); window.oldRender");
      const state = await shown();
      t.diagnostic(JSON.stringify(state));
      assert.equal(state.title, "Chat B");
      assert.ok(state.body.includes("ONLY_CHAT_B"), "late read replaced B's messages");
      assert.ok(!state.body.includes("ONLY_CHAT_A"), "late read rendered A inside B");
    });

    await t.test("a new heading never sits above the previous chat's rows while its storage is loading", async () => {
      await select("A");
      await until('document.getElementById("message-list").textContent.includes("ONLY_CHAT_A")');
      await holdRead();
      await select("B");
      await until("window.heldRead.ready");
      const state = await shown();
      await evaluate("window.heldRead.release(); void 0");
      await until('document.getElementById("message-list").textContent.includes("ONLY_CHAT_B")');
      assert.ok(!state.body.includes("ONLY_CHAT_A"), `previous chat remained visible: ${JSON.stringify(state)}`);
    });

    await t.test("returning to the same chat does not admit a read from the earlier visit", async () => {
      await select("A");
      await until('document.getElementById("message-list").textContent.includes("ONLY_CHAT_A")');
      await holdRead();
      await evaluate(`window.oldRender = AccordAgentsMobile.handleRelayTimelinePayload(${JSON.stringify(batch("A", [event("a", "ONLY_CHAT_A old")]))}); void 0`);
      await until("window.heldRead.ready");
      await select("B");
      await until('document.getElementById("message-list").textContent.includes("ONLY_CHAT_B")');
      await ingest(batch("A", [event("a", "ONLY_CHAT_A newest")]));
      await select("A");
      await until('document.getElementById("message-list").textContent.includes("newest")');
      await evaluate("window.heldRead.release(); window.oldRender");
      assert.ok((await shown()).body.includes("newest"), "earlier visit overwrote the newer snapshot");
    });

    await t.test("leaving a chat cancels its pending visual update", async () => {
      await holdRead();
      await evaluate(`window.oldRender = AccordAgentsMobile.handleRelayTimelinePayload(${JSON.stringify(batch("A", [event("a", "ONLY_CHAT_A")]))}); void 0`);
      await until("window.heldRead.ready");
      await app.click("#back-to-chats");
      await until('document.getElementById("chats-screen").classList.contains("is-active")');
      await evaluate("window.heldRead.release(); window.oldRender");
      assert.equal((await shown()).body, "", "late render restored a chat after Back");
    });

    await t.test("reloading the same chat preserves its open stream, but navigation closes it", async () => {
      const live = { ...event("reload-a", "ONLY_CHAT_A reload stream"), status: "pending", runId: "reload-run-a" };
      await ingest(batch("A", [live]));
      await select("A");
      await until('document.querySelector(".message-row[data-streamable=\\"1\\"]")');
      await app.click('.message-row[data-streamable="1"]');
      await until('!document.getElementById("stream-view").hidden');
      await app.send("Page.reload", { ignoreCache: true });
      await until('Boolean(globalThis.AccordAgentsMobile) && document.getElementById("message-list").textContent.includes("reload stream")');
      assert.equal(await evaluate('document.getElementById("stream-view").hidden'), false);
      assert.ok(await evaluate('document.getElementById("stream-body").textContent.includes("ONLY_CHAT_A reload stream")'));
      await select("B");
      await until('document.getElementById("message-list").textContent.includes("ONLY_CHAT_B")');
      assert.equal(await evaluate('document.getElementById("stream-view").hidden'), true);
      await ingest(batch("A", [{ ...live, status: "done" }]));
    });

    await t.test("a failed read never leaves another chat's messages or Stop control visible", async () => {
      const live = { ...event("running-a", "ONLY_CHAT_A streaming"), status: "pending", runId: "run-a" };
      await ingest(batch("A", [live]));
      await select("A");
      await until('document.querySelector(".message-row[data-streamable=\\"1\\"]")');
      await app.click('.message-row[data-streamable="1"]');
      await until('!document.getElementById("stream-view").hidden');
      await holdRead();
      // This is the navigation state read by render; keep its rejection
      // observable through the existing ingest API for the fault injection.
      await evaluate(`localStorage.setItem("accordagents.mobile.activeConversationId.v1", "B");
        window.failedRender = AccordAgentsMobile.handleRelayTimelinePayload(${JSON.stringify(batch("B", [event("b", "ONLY_CHAT_B")]))}).catch(error => error.message); void 0`);
      await until("window.heldRead.ready");
      assert.equal(await evaluate("window.heldRead.fail(); window.failedRender"), "QA read failed");
      assert.equal((await shown()).body, "");
      assert.equal(await evaluate('document.getElementById("stream-view").hidden'), true);
      await ingest(batch("A", [{ ...live, status: "done" }]));
      await ingest(batch("B", [event("b", "ONLY_CHAT_B")]));
    });

    await t.test("old unscoped rows are kept but are never shown in another chat", async () => {
      await evaluate(`new Promise((resolve, reject) => {
        const open = indexedDB.open("accordagents-mobile-control");
        open.onsuccess = () => {
          const db = open.result, tx = db.transaction("timeline", "readwrite");
          tx.objectStore("timeline").put(${JSON.stringify(event("unscoped", "NO_CHAT_OWNER"))});
          tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
        };
      })`);
      await ingest(batch("B", [event("b", "ONLY_CHAT_B")]));
      const a = await evaluate('AccordAgentsMobile.listTimelineEntries("A")');
      const b = await evaluate('AccordAgentsMobile.listTimelineEntries("B")');
      const all = await evaluate("AccordAgentsMobile.listTimelineEntries()");
      assert.ok(all.some(entry => entry.id === "unscoped"), "fix must not erase messages with unknown ownership");
      assert.ok(!a.some(entry => entry.id === "unscoped"), "unscoped row was filed under A");
      assert.ok(!b.some(entry => entry.id === "unscoped"), "unscoped row was filed under B");
      assert.ok(!(await shown()).body.includes("NO_CHAT_OWNER"));
    });

    await t.test("a terminal in one chat cannot clean up another chat's or unscoped rows", async () => {
      const pending = { ...event("same-id", "Drew is running..."), status: "pending", runId: "same-run", mobileEventId: "same-mobile" };
      await ingest(batch("A", [pending]));
      await ingest(batch("B", [pending]));
      await evaluate(`new Promise((resolve, reject) => {
        const open = indexedDB.open("accordagents-mobile-control");
        open.onsuccess = () => {
          const db = open.result, tx = db.transaction("timeline", "readwrite");
          tx.objectStore("timeline").put(${JSON.stringify({ ...pending, id: "unscoped-pending" })});
          tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
        };
      })`);
      await ingest(batch("B", [{ ...pending, content: "ONLY_CHAT_B finished", status: "done" }]));
      const all = await evaluate("AccordAgentsMobile.listTimelineEntries()");
      assert.ok(all.some(row => row.id === "unscoped-pending"));
      assert.ok(all.some(row => row.conversationId === "A" && row.messageId === "same-id" && row.status === "pending"));
      assert.ok(!all.some(row => row.conversationId === "B" && row.messageId === "same-id" && row.status === "pending"));
      await ingest(batch("A", [{ ...pending, content: "ONLY_CHAT_A finished", status: "done" }]));
    });

    await t.test("interleaved delivery and reload retain each chat's history exactly once", async () => {
      for (const id of ["B", "A", "B", "A"]) {
        await ingest(batch(id, [event(id.toLowerCase(), "ONLY_CHAT_" + id)]));
      }
      // Old/unlabelled packets must not take ownership from the open chat.
      assert.equal(await ingest(batch(undefined, [event("unlabelled", "UNLABELLED_PACKET")])), 0);
      await app.send("Page.reload", { ignoreCache: true });
      await until("Boolean(globalThis.AccordAgentsMobile) && document.querySelectorAll('.mobile-chat-row').length === 2");
      for (const id of ["A", "B"]) {
        await select(id);
        await until(`document.getElementById("message-list").textContent.includes(${JSON.stringify("ONLY_CHAT_" + id)})`);
        const state = await shown();
        assert.ok(!state.body.includes("ONLY_CHAT_" + (id === "A" ? "B" : "A")));
        assert.ok(!state.body.includes("UNLABELLED_PACKET"));
        const entries = await evaluate(`AccordAgentsMobile.listTimelineEntries(${JSON.stringify(id)})`);
        assert.equal(entries.filter(entry => entry.messageId === id.toLowerCase()).length, 1);
      }
    });
  } finally {
    app?.close();
    if (chrome.exitCode === null) { const exited = once(chrome, "exit"); chrome.kill("SIGTERM"); await exited; }
    await new Promise(resolve => site.close(resolve));
    await rm(profile, { recursive: true, force: true });
  }
});
