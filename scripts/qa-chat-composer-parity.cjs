const { attach } = require("./cdp.cjs");

const port = Number(process.env.CDP_PORT || 9222);
const tolerance = 1;

(async () => {
  const app = await attach({ port });
  try {
    const result = await app.evaluate(`(() => {
      const read = (testId) => {
        const composer = document.querySelector('[data-testid="' + testId + '"]');
        const shell = composer?.querySelector(".chat-composer-shell");
        const textarea = composer?.querySelector("textarea");
        if (!composer || !shell || !textarea) {
          throw new Error("Missing composer DOM for " + testId);
        }
        const shellRect = shell.getBoundingClientRect();
        const textareaRect = textarea.getBoundingClientRect();
        const style = getComputedStyle(textarea);
        return {
          shell: {
            top: shellRect.top,
            height: shellRect.height,
            bottom: shellRect.bottom,
            width: shellRect.width
          },
          textarea: {
            height: textareaRect.height,
            scrollHeight: textarea.scrollHeight,
            rows: textarea.rows,
            placeholder: textarea.placeholder,
            fieldSizing: style.fieldSizing,
            minHeight: style.minHeight
          }
        };
      };
      return {
        viewport: {
          width: innerWidth,
          height: innerHeight,
          devicePixelRatio
        },
        main: read("chat-main-composer"),
        thread: read("chat-thread-composer")
      };
    })()`);
    const geometry = result.result.value;
    const heightDelta = Math.abs(geometry.main.shell.height - geometry.thread.shell.height);
    const topDelta = Math.abs(geometry.main.shell.top - geometry.thread.shell.top);
    const evidence = { ...geometry, heightDelta, topDelta, tolerance };
    console.log(JSON.stringify(evidence, null, 2));
    if (heightDelta > tolerance || topDelta > tolerance) {
      process.exitCode = 1;
    }
  } finally {
    app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
