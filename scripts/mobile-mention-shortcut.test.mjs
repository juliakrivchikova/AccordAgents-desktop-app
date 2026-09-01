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
        wrapHeight: document.querySelector(".composer-input-wrap").getBoundingClientRect().height,
        inputHeight: input.getBoundingClientRect().height,
        buttonHeight: document.querySelector("#mention-button").getBoundingClientRect().height,
        padding: getComputedStyle(composer).padding
      };
    })()`), {
      value: "Draft @drew-codex-engineer text",
      caret: 27,
      activeElement: "composer-input",
      inputExpanded: "false",
      wrapHeight: 46,
      inputHeight: 44,
      buttonHeight: 44,
      padding: "10px 16px 14px"
    });
  } finally {
    app?.close();
    chrome.kill("SIGKILL");
    killStaleCdp();
    await new Promise((resolve) => site.close(resolve));
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
});
