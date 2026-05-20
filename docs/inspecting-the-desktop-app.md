# Inspecting and driving the desktop app

When you (an AI agent or a human) need to **see**, **screenshot**, **scroll**, **click**, or **read DOM/CSS state** in the running ai-consensus desktop app — for reproducing UI bugs, verifying fixes, or automated UI checks — use the **Chrome DevTools Protocol** against the Electron renderer. Do not use macOS screencapture, AppleScript, CGWindowList, or any window-focus tricks. Those require accessibility/screen-recording permissions the terminal usually lacks, and they are unreliable.

Electron's renderer process is Chromium. CDP works directly against it.

## When to use this

Reach for this whenever the user asks for any of:

- "Open the desktop app", "see the app", "screenshot the app", "show me the UI"
- "Reproduce this bug", "is the input visible", "is the layout correct"
- "Click X in the app", "type Y into the field", "scroll to Z"
- "What does `<some selector>` look like right now"
- Verifying a renderer-side change without restarting Electron (Vite hot-reloads CSS/JSX)

Skip this for main-process or build issues — those don't need the live UI.

## Fast path for future agents

1. Check whether Electron is already debuggable:

```bash
curl -s --max-time 2 http://127.0.0.1:9222/json
```

If this prints a page target titled `AI Consensus`, attach to that process and do not relaunch anything.

2. If port 9222 is closed but Vite is already running on 5173, reuse Vite and launch only Electron:

```bash
npm run build:main
npx cross-env VITE_DEV_SERVER_URL=http://127.0.0.1:5173 \
  electron . --remote-debugging-port=9222
```

3. If both ports are closed, use the full debug launch in the setup section below.

4. In sandboxed Codex sessions, local port binding or local CDP requests may need escalation. If `vite` fails with `listen EPERM` or CDP `curl` cannot read `127.0.0.1:9222`, rerun the same command with the required sandbox approval instead of switching to macOS window capture.

5. If this workflow still cannot reach or drive the live Electron renderer, stop and ask the user how to proceed. Offer concrete choices: relaunch/quit the desktop app and retry with the debug port, use a renderer mock or browser fixture as a limited fallback, or skip visual verification. Do not silently treat a Vite/browser fixture as desktop-app validation.

6. Prefer the checked-in helpers:

```bash
node scripts/screenshot.cjs app.png
```

For interaction scripts:

```js
const { attach } = require("./scripts/cdp.cjs");

(async () => {
  const app = await attach();
  await app.click("[data-testid='new-session']");
  await app.fill("textarea", "Message text");
  const state = await app.evaluate(`document.body.innerText`);
  console.log(state.result.value);
  app.close();
})();
```

Use stable selectors such as `data-testid` when they exist. If they do not exist yet, add them as part of UI work rather than relying on fragile text or DOM-depth selectors.

## Setup: launch with remote debugging

The `npm run dev` (and `make dev`) flow does **not** enable CDP by default. Two ways to get it on:

### Option A — one-shot relaunch with the debug flag

If the app isn't already running with port 9222 open, kill any existing Electron for this repo and start fresh:

```bash
# Quit the current instance (if any) — find by repo path
pkill -f "electron .*ai-consensus" 2>/dev/null

# Relaunch with the debug port
cd /Users/ysvetlichnaya/IdeaProjects/ai-consensus
npx concurrently -k \
  "vite --host 127.0.0.1" \
  "wait-on tcp:5173 && npm run build:main && \
   cross-env VITE_DEV_SERVER_URL=http://127.0.0.1:5173 \
   electron . --remote-debugging-port=9222"
```

Wait ~6 seconds for Electron to boot, then verify:

```bash
curl -s http://127.0.0.1:9222/json/version
```

If that returns JSON, you're attached.

### Option B — only Codex's SQLite is locked

Don't spawn a second Electron instance against the same `~/Library/Application Support/ai-consensus/ai-consensus.sqlite3` — there's a lock. Always quit the existing instance before relaunching with the flag.

## Find the renderer page

CDP exposes one or more "targets" on `http://127.0.0.1:9222/json`. The renderer you want is the one whose `type` is `page` and `title` is `AI Consensus`:

```bash
curl -s http://127.0.0.1:9222/json | jq -r '.[] | select(.type=="page" and .title=="AI Consensus") | .webSocketDebuggerUrl'
```

That WebSocket URL (e.g. `ws://127.0.0.1:9222/devtools/page/<id>`) is what you connect to.

## Drive the app

CDP is JSON-RPC over WebSocket. From Node, use the `ws` module. This repo has `scripts/cdp.cjs`; use it for timed CDP calls, selector waits, clicks, fills, runtime evaluation, and screencast screenshots. If `ws` is not installed, run `npm install ws --no-save` in the repo directory.

The helper exposes:

- `attach()` to connect to the `AI Consensus` page target on port 9222.
- `send(method, params)` for raw CDP calls.
- `evaluate(expression)` for renderer-side JavaScript.
- `waitForSelector(selector)`, `click(selector)`, and `fill(selector, value)` for UI flows.
- `screenshot()` for a live renderer PNG using CDP screencast frames.

Minimal manual helper, if the script is missing:

```js
const http = require("node:http");
const WebSocket = require("ws");

async function attach() {
  const targets = await new Promise((resolve, reject) =>
    http.get("http://127.0.0.1:9222/json", (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve(JSON.parse(body)));
    }).on("error", reject)
  );
  const page = targets.find((t) => t.type === "page" && t.title === "AI Consensus");
  if (!page) throw new Error("AI Consensus page not found among CDP targets");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  let nextId = 1;
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const onMessage = (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.id !== id) return;
        ws.off("message", onMessage);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      };
      ws.on("message", onMessage);
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { send, close: () => ws.close() };
}

module.exports = { attach };
```

### Common operations

```js
const { attach } = require("./scripts/cdp.cjs");
const fs = require("node:fs");

(async () => {
  const { send, close } = await attach();

  // Read DOM / computed styles
  const layout = await send("Runtime.evaluate", {
    expression: `(() => {
      const c = document.querySelector(".chat-composer");
      return c ? JSON.stringify(c.getBoundingClientRect()) : null;
    })()`,
    returnByValue: true,
    awaitPromise: true
  });
  console.log(layout.result.value);

  // Click an element / type / scroll — all expressed as live JS in the page.
  await send("Runtime.evaluate", {
    expression: `document.querySelector(".history-item").click()`
  });

  // Screenshot the live window. In Electron, Page.captureScreenshot can hang;
  // prefer scripts/screenshot.cjs or Page.startScreencast for reliable captures.
  const shot = await send("Page.captureScreenshot", { format: "png" });
  fs.mkdirSync("screenshots", { recursive: true });
  fs.writeFileSync("screenshots/desktop.png", Buffer.from(shot.data, "base64"));

  // Reload (e.g., after a CSS change Vite didn't HMR)
  await send("Page.reload");

  close();
})();
```

## Where to save artifacts

Screenshots → `screenshots/<descriptive-name>.png` in the repo root. `screenshots/` is ignored by git.

## Interaction tips

- Treat the Electron renderer as the source of truth. Use CDP runtime evaluation to inspect DOM, computed styles, local UI state, and rendered text.
- For clicks, prefer `app.click(selector)` when testing a user-visible action. For more realistic pointer testing, use CDP `Input.dispatchMouseEvent` with coordinates from `getBoundingClientRect()`.
- For typing into text fields, prefer `app.fill(selector, value)` for deterministic setup. When testing keyboard-specific behavior, focus the field and use `Input.dispatchKeyEvent` or `Input.insertText`.
- For scrolling, run `element.scrollIntoView()` or set `scrollTop` via `evaluate()`, then inspect bounds or take a screenshot.
- For assertions, read the DOM or computed styles with `evaluate()` and print concise JSON. Do not infer UI state only from a screenshot.
- If a screenshot is needed, use `node scripts/screenshot.cjs <name>.png`. The helper uses CDP screencast frames because `Page.captureScreenshot` has timed out in this Electron app.
- Close helper WebSocket connections with `app.close()` when a script is done. Do not kill an existing Electron process unless relaunching with `--remote-debugging-port=9222` is necessary.

## Sanity check

When the user asks "can you see the app?", run:

```bash
curl -s http://127.0.0.1:9222/json | jq -r '.[] | select(.type=="page") | .title'
```

If it prints `AI Consensus`, you're attached. Otherwise relaunch per Option A.

## What NOT to do

- **Don't** `screencapture`, `osascript`, AppleScript, CGWindowList, or any other macOS UI capture API. They require permissions the terminal usually lacks and they target the wrong window.
- **Don't** curl `http://127.0.0.1:5173/` expecting to see the app. That's just Vite's bundle for the renderer — it has no Electron preload, so the React app crashes when loaded outside Electron.
- **Don't** spawn a second Electron instance against the live SQLite DB. Quit the current one first.
- **Don't** hand-write screenshots into the repo root. Use `screenshots/`.
