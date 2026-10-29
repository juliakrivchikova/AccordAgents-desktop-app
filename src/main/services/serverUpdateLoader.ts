import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { BrowserWindow } from "electron";

/**
 * The first start after the desktop updated, when the User's server still
 * runs the older program: the desktop updates the server before it opens
 * (the User, 2026-10-29). Only this loader is shown meanwhile, and no member
 * starts — the server stops for a few seconds while its program is replaced,
 * and the User should not have to know to keep everything quiet for it.
 */

export type ServerUpdateOutcome = "updated" | "unconfirmed" | "failed" | "timed-out";

export interface ServerUpdateStatus {
  /** What the loader says under its heading. */
  status: (text: string, tone?: "info" | "error") => void;
}

export interface ServerUpdateBeforeOpeningOptions {
  /** Whether the server has confirmed that this desktop is its owner: only
   *  the owner replaces its program. */
  ownerConfirmed: () => boolean;
  /** Replaces the program, as Settings' Update does. */
  install: () => Promise<{ status: string; message?: string }>;
  loader: ServerUpdateStatus;
  log: (event: string, payload: Record<string, unknown>) => void;
  from: string;
  to: string;
  /** How long the server has to answer before the app opens without it. */
  ownerWaitMs?: number;
  /** The longest the app waits for the program to be replaced; the update
   *  goes on behind the opened app after that. */
  installCapMs?: number;
  /** How long a notice that the server will update later stays up. */
  noticeMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const OWNER_WAIT_MS = 20_000;
const INSTALL_CAP_MS = 4 * 60_000;
const NOTICE_MS = 4_000;

export async function updateServerBeforeOpening(options: ServerUpdateBeforeOpeningOptions): Promise<ServerUpdateOutcome> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = options.pollMs ?? 250;
  const ownerWaitMs = options.ownerWaitMs ?? OWNER_WAIT_MS;
  const noticeMs = options.noticeMs ?? NOTICE_MS;
  options.loader.status("Connecting to your server…");
  for (let waited = 0; !options.ownerConfirmed() && waited < ownerWaitMs; waited += pollMs) await sleep(pollMs);
  if (!options.ownerConfirmed()) {
    options.log("hub.program-update.before-opening", { outcome: "unconfirmed", from: options.from, to: options.to });
    options.loader.status("Your server did not answer. It will be updated later.", "error");
    await sleep(noticeMs);
    return "unconfirmed";
  }
  options.log("hub.program-update.start", { from: options.from, to: options.to, attempt: 1, beforeOpening: true });
  options.loader.status("Updating the program on your server…");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<"timed-out">((resolve) => { timer = setTimeout(() => resolve("timed-out"), options.installCapMs ?? INSTALL_CAP_MS); });
  try {
    const result = await Promise.race([
      options.install().then((state) => state, (error: unknown) => ({ status: "failed", message: error instanceof Error ? error.message : String(error) })),
      cap
    ]);
    if (result === "timed-out") {
      options.log("hub.program-update.before-opening", { outcome: "timed-out", from: options.from, to: options.to });
      options.loader.status("Your server is taking long to update. It finishes while AccordAgents is open.", "error");
      await sleep(noticeMs);
      return "timed-out";
    }
    options.log("hub.program-update.finished", { status: result.status, message: result.message ?? "", beforeOpening: true });
    if (result.status !== "ready") {
      const reason = result.message?.trim();
      options.loader.status(`Your server could not be updated${reason ? `: ${/[.!?]$/.test(reason) ? reason : `${reason}.`}` : "."} AccordAgents will try again later.`, "error");
      await sleep(noticeMs);
      return "failed";
    }
    return "updated";
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The loader's page: the mark, what is happening, and why the app waits. */
export function serverUpdateLoaderHtml(logoDataUrl: string | undefined): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>AccordAgents</title>
<style>
  :root { color-scheme: light dark; --bg: #f5f2ec; --fg1: #16191f; --fg: #4a5160; --mut: #868d9b; --danger: #b4443a; --acc: #7d5fd3; }
  @media (prefers-color-scheme: dark) { :root { --bg: #15171c; --fg1: #f1f3f7; --fg: #c1c7d2; --mut: #7f8794; --danger: #ff8a80; --acc: #b39ef0; } }
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0; background: var(--bg); color: var(--fg);
    font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; text-align: center; padding: 0 32px; box-sizing: border-box;
    -webkit-user-select: none; user-select: none; -webkit-app-region: drag; }
  .logo { width: 56px; height: 56px; margin-bottom: 16px; animation: turn 2.4s linear infinite; }
  @media (prefers-reduced-motion: reduce) { .logo { animation: none; } }
  @keyframes turn { to { transform: rotate(360deg); } }
  h1 { margin: 0; font-size: 19px; font-weight: 700; color: var(--fg1); }
  p { margin: 8px 0 0; line-height: 1.45; }
  #status { min-height: 20px; max-height: 64px; overflow: hidden; margin-top: 14px; color: var(--mut); overflow-wrap: anywhere; }
  #status[data-tone="error"] { color: var(--danger); }
</style></head>
<body>
  ${logoDataUrl ? `<img class="logo" src="${logoDataUrl}" alt="">` : ""}
  <h1>Updating your server…</h1>
  <p>AccordAgents opens when it is done.<br>Members wait until then.</p>
  <p id="status" role="status">Getting ready\u2026</p>
</body></html>`;
}

/** The desktop's mark, from the renderer's assets (Vite names it with a hash). */
function logoDataUrl(rendererAssetsDir: string): string | undefined {
  try {
    const name = readdirSync(rendererAssetsDir).find((file) => /^accordagents-mark.*\.png$/.test(file));
    return name ? `data:image/png;base64,${readFileSync(path.join(rendererAssetsDir, name)).toString("base64")}` : undefined;
  } catch {
    return undefined;
  }
}

export interface ServerUpdateLoaderWindow extends ServerUpdateStatus {
  close: () => void;
}

/** The loader's windows: no question (an update's Restart) is asked on one. */
const loaderWindowIds = new Set<number>();
export function isServerUpdateLoaderWindow(window: BrowserWindow): boolean {
  return loaderWindowIds.has(window.id);
}

/** A small window of its own, shown at once; the app's window replaces it. */
export function openServerUpdateLoader(rendererAssetsDir: string): ServerUpdateLoaderWindow {
  const window = new BrowserWindow({
    width: 440,
    height: 300,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "AccordAgents",
    backgroundColor: "#f5f2ec",
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const } : {}),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  const windowId = window.id;
  loaderWindowIds.add(windowId);
  window.on("closed", () => { loaderWindowIds.delete(windowId); });
  // Until the update itself starts, the desktop is still starting up: said by
  // the page itself, before anything is sent to it.
  const apply = (text: string, tone?: string): void => {
    if (window.isDestroyed()) return;
    // Sent at once: Electron runs it as soon as the page can (still loading
    // when its load has just finished, by Electron's own account), in order.
    void window.webContents.executeJavaScript(`(() => { const node = document.getElementById("status"); node.textContent = ${JSON.stringify(text)};
      if (${JSON.stringify(tone ?? "")}) node.dataset.tone = ${JSON.stringify(tone ?? "")}; else delete node.dataset.tone; })()`).catch(() => undefined);
  };
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(serverUpdateLoaderHtml(logoDataUrl(rendererAssetsDir)))}`);
  return {
    status: (text, tone) => apply(text, tone),
    close: () => {
      if (!window.isDestroyed()) window.destroy();
    }
  };
}
