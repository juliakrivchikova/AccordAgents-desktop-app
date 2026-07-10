const fs = require("node:fs");
const path = require("node:path");

const { attach } = require("./cdp.cjs");

const port = Number(process.env.CDP_PORT || 9222);
const tolerance = 1;
const mainSelector = "[data-testid=chat-main-composer] textarea";
const threadSelector = "[data-testid=chat-thread-composer] textarea";

function assertWithinTolerance(value, label) {
  if (value > tolerance) {
    throw new Error(`${label} was ${value}px; tolerance is ${tolerance}px`);
  }
}

(async () => {
  const app = await attach({ port });
  const evidence = [];
  try {
    const read = async (label) => {
      const result = await app.evaluate(`(() => {
        const readComposer = (testId) => {
          const composer = document.querySelector('[data-testid="' + testId + '"]');
          const shell = composer?.querySelector(".chat-composer-shell");
          const textarea = composer?.querySelector("textarea");
          if (!shell || !textarea) throw new Error("Missing composer: " + testId);
          const shellRect = shell.getBoundingClientRect();
          return {
            shell: {
              top: shellRect.top,
              height: shellRect.height,
              bottom: shellRect.bottom
            },
            textarea: {
              clientHeight: textarea.clientHeight,
              scrollHeight: textarea.scrollHeight,
              valueLength: textarea.value.length
            }
          };
        };
        return {
          timestamp: new Date().toISOString(),
          viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
          main: readComposer("chat-main-composer"),
          thread: readComposer("chat-thread-composer"),
          theme: document.documentElement.getAttribute("data-theme") || document.documentElement.className
        };
      })()`);
      const state = { label, ...result.result.value };
      state.heightDelta = Math.abs(state.main.shell.height - state.thread.shell.height);
      state.topDelta = Math.abs(state.main.shell.top - state.thread.shell.top);
      state.bottomDelta = Math.abs(state.main.shell.bottom - state.thread.shell.bottom);
      evidence.push(state);
      return state;
    };

    const assertParity = async (label) => {
      const state = await read(label);
      assertWithinTolerance(state.heightDelta, `${label} height delta`);
      assertWithinTolerance(state.topDelta, `${label} top delta`);
      return state;
    };

    await app.fill(mainSelector, "");
    await app.fill(threadSelector, "");
    await assertParity("focused-empty");

    await app.fill(mainSelector, "One line draft");
    await app.fill(threadSelector, "One line draft");
    await assertParity("equal-one-line");

    const multiline = "Line one\nLine two\nLine three";
    await app.fill(mainSelector, multiline);
    await app.fill(threadSelector, multiline);
    await assertParity("equal-multiline");

    const maximum = Array.from({ length: 24 }, (_, index) => `Line ${index + 1}`).join("\n");
    await app.fill(mainSelector, maximum);
    await app.fill(threadSelector, maximum);
    const maximumState = await assertParity("equal-max-scroll");
    if (maximumState.main.textarea.scrollHeight <= maximumState.main.textarea.clientHeight
      || maximumState.thread.textarea.scrollHeight <= maximumState.thread.textarea.clientHeight) {
      throw new Error("Maximum-height state did not scroll in both composers");
    }

    await app.fill(mainSelector, multiline);
    await app.fill(threadSelector, "One line draft");
    const independentState = await read("independent-growth");
    assertWithinTolerance(independentState.bottomDelta, "independent-growth bottom delta");
    if (independentState.main.shell.height <= independentState.thread.shell.height) {
      throw new Error("Only the main composer should grow in independent-growth state");
    }

    await app.fill(mainSelector, "");
    await app.fill(threadSelector, "");
    await app.click("[data-testid=theme-toggle]");
    await assertParity("theme-toggled");

    await app.evaluate(`(() => {
      const button = [...document.querySelectorAll("button")]
        .find((candidate) => candidate.getAttribute("aria-label") === "Close thread");
      if (!button) throw new Error("Close thread button not found");
      button.click();
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await app.evaluate(`(() => {
      const button = [...document.querySelectorAll("button")]
        .find((candidate) => candidate.getAttribute("aria-label") === "Reply in thread");
      if (!button) throw new Error("Reply in thread button not found");
      button.click();
    })()`);
    await app.waitForSelector("[data-testid=chat-thread-panel]");
    await assertParity("thread-close-reopen");

    if (process.env.QA_SCREENSHOT) {
      const screenshot = await app.screenshot({ timeoutMs: 15000 });
      const outputPath = path.resolve(process.env.QA_SCREENSHOT);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, screenshot.data);
    }

    console.log(JSON.stringify({ tolerance, evidence }, null, 2));
  } finally {
    app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
