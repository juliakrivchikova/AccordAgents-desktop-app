// Browser regression for chat switching and delivery into the PWA's real IDB.
// This deliberately delays an IDB read, not application code: a render that
// started for A must never replace B after the user navigates away. The
// phone is paired with a real hub (the User's own server) that holds both
// chats; the deliveries go through the app's own ingest path.
// Supporting browser evidence only; this is not an installed-iPhone check.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { CHROME, attachApp, member, pairPage, serveMobileShell, startMobileHub } from "./mobile-hub-fixture.mjs";

const event = (id, content) => ({ id, messageId: id, role: "participant", participantLabel: "Drew", content,
  status: "done", createdAt: "2026-09-11T22:00:00.000Z" });
const batch = (conversationId, events) => ({ type: "mobile.timeline.events", conversationId, events });

test("the PWA keeps persisted and rendered messages in their own chat", { timeout: 90_000 }, async t => {
  const hub = await startMobileHub();
  for (const id of ["A", "B"]) {
    await hub.createChat(id, { title: "Chat " + id, repoPath: "/work/QA", participants: [member("drew")], createdAt: "2026-09-11T22:00:00.000Z" });
  }
  const shell = await serveMobileShell({ hubOrigins: [hub.base] });
  const origin = shell.origin;
  const profile = await mkdtemp(path.join(tmpdir(), "aa-chat-isolation-"));
  const chrome = spawn(CHROME, ["--headless=new", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=430,860", origin], { stdio: "ignore" });
  let app;
  try {
    for (let i = 0; i < 60 && !app; i++) {
      try {
        const port = Number((await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]);
        app = await attachApp({ port, attempts: 1 });
      } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.ok(app, "Chrome did not expose the PWA");
    const evaluate = async code => (await app.rawEvaluate(code)).result.value;
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
    await pairPage(app, { hub, siteOrigin: origin });
    await until("document.querySelectorAll('.mobile-chat-row').length === 2");
    await ingest(batch("A", [event("a", "ONLY_CHAT_A")]));
    await ingest(batch("B", [event("b", "ONLY_CHAT_B")]));
    await select("A");
    await until('document.getElementById("message-list").textContent.includes("ONLY_CHAT_A")');

    await t.test("a delayed waiting snapshot cannot erase live text or revive its finished row", async () => {
      const waiting = { ...event("waiting-a", "Drew is running..."), status: "pending", runId: "waiting-run-a" };
      await ingest(batch("A", [waiting]));
      let rows = await evaluate('AccordAgentsMobile.listTimelineEntries("A")');
      assert.equal(rows.find(row => row.messageId === "waiting-a").status, "pending");
      await ingest(batch("A", [{ ...waiting, content: "LIVE_PROGRESS_CONTENT" }]));
      await until('document.getElementById("message-list").textContent.includes("LIVE_PROGRESS_CONTENT")');
      // The chat's page carries the durable waiting row, while the growing
      // text arrives separately with the server's live progress.
      await ingest(batch("A", [waiting]));
      assert.ok((await shown()).body.includes("LIVE_PROGRESS_CONTENT"));
      await ingest(batch("B", [waiting]));
      rows = await evaluate('AccordAgentsMobile.listTimelineEntries("B")');
      assert.equal(rows.find(row => row.messageId === "waiting-a").content, "Drew is running...", "another chat must not lend its live content");
      await ingest(batch("A", [{ ...waiting, status: "error", content: "Interrupted before completion." }]));
      await ingest(batch("A", [waiting]));
      rows = await evaluate('AccordAgentsMobile.listTimelineEntries("A")');
      assert.equal(rows.filter(row => row.messageId === "waiting-a").length, 1);
      assert.equal(rows.find(row => row.messageId === "waiting-a").status, "error");
    });

    await t.test("live updates retain the waiting row's thread and start time", async () => {
      const waiting = { ...event("thread-progress", "Drew is running..."), status: "pending",
        runId: "thread-progress-run", threadRootId: "a" };
      await ingest(batch("A", [waiting]));
      const { threadRootId, ...live } = waiting;
      await ingest(batch("A", [{ ...live, content: "THREADED_PROGRESS", createdAt: "2026-09-11T22:00:20.000Z" }]));
      const stored = (await evaluate('AccordAgentsMobile.listTimelineEntries("A")')).find(row => row.messageId === "thread-progress");
      assert.equal(stored.threadRootId, threadRootId);
      assert.equal(stored.createdAt, waiting.createdAt);
      assert.equal(stored.content, "THREADED_PROGRESS");
      await ingest(batch("A", [{ ...waiting, status: "done", content: "Thread finished" }]));
    });

    await t.test("cached live rows can be opened while initial synchronization with the server is still waiting", async () => {
      const pending = { ...event("startup-live", "CACHED_STARTUP_PROGRESS"), status: "pending", runId: "startup-live-run" };
      await ingest(batch("A", [pending]));
      // Hold the transport, not application callbacks: the server answers
      // nothing until released, and the page must remain interactive
      // throughout the real initialization await chain.
      let release;
      const held = new Promise(resolve => { release = resolve; });
      hub.setGate(() => held);
      try {
        await app.send("Page.reload", { ignoreCache: true });
        await until('Boolean(globalThis.AccordAgentsMobile) && document.getElementById("message-list").textContent.includes("CACHED_STARTUP_PROGRESS")');
        await app.click('.message-row[data-streamable="1"]');
        await until('!document.getElementById("stream-view").hidden');
        assert.ok(await evaluate('document.getElementById("stream-body").textContent.includes("CACHED_STARTUP_PROGRESS")'));
        assert.ok(hub.requests.some(request => request.path === "/v1/phone/chats" && request.at > Date.now() - 30_000), "the page did ask the server");
        await app.click("#stream-close");
      } finally {
        hub.setGate(undefined);
        release();
        await app.send("Page.reload", { ignoreCache: true });
        await until('Boolean(globalThis.AccordAgentsMobile) && document.getElementById("message-list").textContent.includes("CACHED_STARTUP_PROGRESS")');
        await ingest(batch("A", [{ ...pending, status: "done" }]));
      }
    });

    // A completed IDB transaction may resolve the read's data later than
    // another render. Hold only one readonly timeline request; writes, the
    // database contents, and every later read retain their normal behavior.
    // The timeline is read by chat through its index, and the whole store
    // only when no chat is named; a held read has to catch either.
    //
    // The held read must be the one the step under test makes. Two other
    // readers share the store with it: a read the server's answer to an
    // earlier step is still bringing in (waited out first), and the open
    // chat's live-progress poll, which reads it every second and a half while
    // the app is in front. The poll is paused while a read is held by having
    // the page read as hidden to it; drawing does not ask, so nothing under
    // test changes.
    const holdRead = async () => {
      await hub.quiet();
      return evaluate(`(() => {
      const originals = { store: IDBObjectStore.prototype.getAll, index: IDBIndex.prototype.getAll };
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      const resume = () => { delete document.visibilityState; };
      const restore = () => {
        IDBObjectStore.prototype.getAll = originals.store;
        IDBIndex.prototype.getAll = originals.index;
      };
      window.heldRead = { ready: false };
      const hold = (original, storeOf) => function (...args) {
        const request = original.apply(this, args);
        const store = storeOf(this);
        if (store.name !== "timeline" || store.transaction.mode !== "readonly") return request;
        restore();
        const held = window.heldRead;
        const proxy = { get result() { return request.result; }, get error() { return request.error; } };
        request.onsuccess = event => {
          held.release = () => { resume(); proxy.onsuccess?.(event); held.released = true; };
          held.fail = () => {
            resume();
            Object.defineProperty(proxy, "error", { value: new DOMException("QA read failed", "UnknownError") });
            proxy.onerror?.(event);
          };
          held.ready = true;
        };
        request.onerror = event => { resume(); proxy.onerror?.(event); };
        return proxy;
      };
      IDBObjectStore.prototype.getAll = hold(originals.store, (target) => target);
      IDBIndex.prototype.getAll = hold(originals.index, (target) => target.objectStore);
    })()`);
    };

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
    await shell.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true });
  }
});
