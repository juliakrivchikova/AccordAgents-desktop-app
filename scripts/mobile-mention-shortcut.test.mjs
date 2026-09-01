// Permanent browser coverage for the phone composer's mention shortcut.
// Real touch events are required here: a synthetic HTMLElement.click() would
// never exercise the focus guard. The post-release menu assertions make that
// guard load-bearing because losing focus closes the menu on blur.
import assert from "node:assert/strict";
import { execSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { attach } = require("./cdp.cjs");
const { loadMobileOriginHeaders, mobileOriginHeadersForPath } = require("./mobile-origin-headers.cjs");

const repoRoot = path.resolve(import.meta.dirname, "..");
const root = path.join(repoRoot, "dist/mobile");
const SITE_PORT = 8195;
const CDP_PORT = 9353;
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json"
};

const originHeaders = loadMobileOriginHeaders(root);
const site = createServer(async (req, res) => {
  const rel = (req.url || "/").split("?")[0];
  const file = path.join(root, rel === "/" ? "index.html" : rel);
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] || "application/octet-stream",
      ...mobileOriginHeadersForPath(originHeaders, rel)
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

const waitFor = async (read, predicate, description) => {
  let value;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(`${description}: ${JSON.stringify(value)}`);
};

const killStaleCdp = () => {
  try {
    execSync(`lsof -ti tcp:${CDP_PORT} -sTCP:LISTEN | xargs kill -9`, { stdio: "ignore" });
  } catch {
    // Nothing is listening on this test's dedicated port.
  }
};

test("mention shortcut opens the wired menu without taking pointer focus", async () => {
  await new Promise((resolve) => site.listen(SITE_PORT, "127.0.0.1", resolve));
  killStaleCdp();
  const profile = await mkdtemp(path.join(tmpdir(), "aa-mobile-mention-"));
  const chrome = spawn(CHROME, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=430,860",
    `http://127.0.0.1:${SITE_PORT}/`
  ], { stdio: "ignore" });

  let app;
  try {
    for (let attempt = 0; attempt < 40 && !app; attempt += 1) {
      try {
        app = await attach({ port: CDP_PORT, title: "AccordAgents" });
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    assert.ok(app, "could not attach to Chrome");
    const evaluate = async (expression) => (await app.evaluate(expression)).result.value;

    await waitFor(
      () => evaluate(`Boolean(globalThis.AccordAgentsMobile && document.querySelector("#mention-button"))`),
      Boolean,
      "mobile runtime did not initialize"
    );

    await evaluate(`(() => {
      localStorage.setItem("accordagents.mobile.pairing.v1", JSON.stringify({
        endpoint: "ws://127.0.0.1:9",
        conversationId: "mention-qa",
        relaySealKeyBase64: "${"a".repeat(43)}",
        pairedAt: new Date(0).toISOString()
      }));
      localStorage.setItem("accordagents.mobile.chatList.v1", JSON.stringify([{
        id: "mention-qa",
        title: "Mention QA",
        updatedAt: new Date(0).toISOString(),
        members: [{
          id: "taylor",
          handle: "taylor-claude-engineer",
          mentionHandle: "taylor-claude-engineer",
          displayName: "Taylor",
          roleLabel: "Software Engineer"
        }, {
          id: "drew",
          handle: "drew-codex-engineer",
          mentionHandle: "drew-codex-engineer",
          displayName: "Drew",
          roleLabel: "Software Engineer"
        }]
      }]));
      localStorage.setItem("accordagents.mobile.activeConversationId.v1", "mention-qa");
      document.querySelector("#chats-screen").classList.remove("is-active");
      document.querySelector("#timeline-screen").classList.add("is-active");
      return true;
    })()`);

    await evaluate(`(() => {
      const input = document.querySelector("#composer-input");
      input.value = "";
      input.focus();
      input.setSelectionRange(0, 0);
    })()`);
    await app.touchStart("#mention-button");
    assert.equal(await evaluate(`document.activeElement?.id`), "composer-input");
    await app.touchEnd();
    assert.deepEqual(await evaluate(`(() => ({
      value: document.querySelector("#composer-input").value,
      caret: document.querySelector("#composer-input").selectionStart,
      inputExpanded: document.querySelector("#composer-input").getAttribute("aria-expanded"),
      optionCount: document.querySelectorAll("#mention-menu .mobile-mention-option").length
    }))()`), {
      value: "@",
      caret: 1,
      inputExpanded: "true",
      optionCount: 2
    });
    await app.touchStart("#mention-option-0");
    assert.equal(await evaluate(`document.activeElement?.id`), "composer-input");
    await app.touchEnd();
    assert.equal(await evaluate(`document.querySelector("#composer-input").value`), "@taylor-claude-engineer ");

    await evaluate(`(() => {
      const input = document.querySelector("#composer-input");
      input.value = "Ask @dr";
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    })()`);
    assert.equal(await evaluate(`document.querySelector("#mention-menu").hidden`), false);
    await evaluate(`document.querySelector("#composer-input").setSelectionRange(0, 0)`);
    await waitFor(
      () => evaluate(`document.querySelector("#mention-menu").hidden`),
      Boolean,
      "moving the caret away from a mention did not close the menu"
    );

    await evaluate(`(() => {
      const input = document.querySelector("#composer-input");
      input.value = "Draft text";
      input.focus();
      input.setSelectionRange(5, 5);
    })()`);
    await app.touchStart("#mention-button");
    assert.equal(await evaluate(`document.activeElement?.id`), "composer-input");
    await app.touchEnd();
    assert.equal(await evaluate(`document.querySelector("#composer-input").value`), "Draft @ text");
    await app.touchStart("#mention-option-1");
    assert.equal(await evaluate(`document.activeElement?.id`), "composer-input");
    await app.touchEnd();
    assert.deepEqual(await evaluate(`(() => {
      const composer = document.querySelector("#composer-form");
      const input = document.querySelector("#composer-input");
      return {
        value: input.value,
        caret: input.selectionStart,
        activeElement: document.activeElement?.id,
        inputExpanded: input.getAttribute("aria-expanded"),
        // The pill is two rows now — field above, controls below — so pin the
        // relationships that matter rather than a fixed height: the field spans
        // the pill's width, and no control is layered over it. An overlay on the
        // field is what stopped the iOS keyboard appearing once already.
        fieldSpansPill: (() => {
          const field = input.getBoundingClientRect();
          const pill = document.querySelector(".composer-input-wrap").getBoundingClientRect();
          // Within the pill's 1px border on each side.
          return Math.abs(field.left - pill.left) <= 2 && Math.abs(pill.right - field.right) <= 2;
        })(),
        controlsBelowField: document.querySelector(".composer-toolbar").getBoundingClientRect().top >=
          input.getBoundingClientRect().bottom,
        sendIsLast: document.querySelector(".composer-toolbar").lastElementChild?.id,
        padding: getComputedStyle(composer).padding
      };
    })()`), {
      value: "Draft @drew-codex-engineer text",
      caret: 27,
      activeElement: "composer-input",
      inputExpanded: "false",
      fieldSpansPill: true,
      controlsBelowField: true,
      sendIsLast: "send-button",
      padding: "10px 16px 14px"
    });

    // A picture is prepared on the way into the queue, not merely somewhere in
    // the file. Source pins alone would pass with the preparation removed from
    // this path, which is the whole point of doing it in the browser.
    assert.deepEqual(await evaluate(`(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 4000;
      canvas.height = 3000;
      const context = canvas.getContext("2d");
      context.fillStyle = "#123456";
      context.fillRect(0, 0, 4000, 3000);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      const file = new File([blob], "wide.PNG", { type: "image/png" });
      const rejected = await globalThis.AccordAgentsMobile.addPendingAttachments([file]);
      const queued = globalThis.AccordAgentsMobile.takePendingAttachments();
      // The origin's CSP has no data: in connect-src, so the bytes are decoded
      // here rather than fetched back as a data URL.
      const binary = atob(queued[0].dataBase64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      const decoded = await createImageBitmap(new Blob([bytes], { type: queued[0].mimeType }));
      return {
        rejected: rejected.length,
        queued: queued.length,
        mimeType: queued[0].mimeType,
        filename: queued[0].filename,
        longEdge: Math.max(decoded.width, decoded.height),
        aspectKept: Math.round((decoded.width / decoded.height) * 100) / 100
      };
    })()`), {
      rejected: 0,
      queued: 1,
      // A PNG stays a PNG: JPEG would drop transparency, and the extension has
      // to follow the bytes rather than the original name.
      mimeType: "image/png",
      filename: "wide.png",
      longEdge: 2576,
      aspectKept: 1.33
    });

    // A message that carries a picture must actually show one on the phone.
    // The projection, the ingestion and the row rendering are three separate
    // places this can be lost, so the check goes through the app's own
    // ingestion and then looks at the rendered DOM.
    assert.deepEqual(await evaluate(`(async () => {
      await globalThis.AccordAgentsMobile.handleRelayTimelinePayload({
        type: "mobile.timeline.events",
        conversationId: "mention-qa",
        events: [{
          id: "picture-row",
          role: "participant",
          participantLabel: "@taylor-claude-engineer",
          content: "",
          status: "done",
          createdAt: new Date().toISOString(),
          attachments: [{
            id: "attachment-render-check",
            filename: "shot.png",
            mimeType: "image/png",
            sizeBytes: 3,
            width: 40,
            height: 20
          }]
        }]
      }, "mention-qa");
      const stored = await globalThis.AccordAgentsMobile.listTimelineEntries("mention-qa");
      const row = stored.find((entry) => entry.sourceId === "picture-row");
      await new Promise((resolve) => setTimeout(resolve, 300));
      const images = document.querySelectorAll(".message-images .message-image");
      return {
        // A caption-less picture is a message, so the row must survive storage.
        storedAttachments: row?.attachments?.length ?? 0,
        renderedImages: images.length,
        reservedBox: images[0] ? images[0].getAttribute("width") + "x" + images[0].getAttribute("height") : ""
      };
    })()`), {
      storedAttachments: 1,
      renderedImages: 1,
      // The box is reserved from the real dimensions so the list does not jump
      // when the bytes land.
      reservedBox: "40x20"
    });
  } finally {
    app?.close();
    chrome.kill("SIGKILL");
    killStaleCdp();
    await new Promise((resolve) => site.close(resolve));
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
});
