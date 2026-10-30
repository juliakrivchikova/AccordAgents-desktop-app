import { FILE_PREVIEW_PROTOCOL } from "../../shared/filePreview";

/** How long closing, quitting or restarting for an update waits for the panel to save. */
export const FILE_EDIT_FLUSH_TIMEOUT_MS = 2_000;
/** A page in the panel opens at most one outside link in this time. */
export const EXTERNAL_OPEN_MIN_INTERVAL_MS = 3_000;

/**
 * The main process asks the window to save every file open in its panel and
 * waits for the answer, at most a timeout. A window that cannot be asked, or
 * does not answer, never holds up what comes next: the unsaved text is kept in
 * userData and offered again at the next start.
 */
export function createFileEditFlusher(options: {
  /** Sends the request to the window; false when there is no window to ask. */
  send: (requestId: string) => boolean;
  log: (event: string, payload: Record<string, unknown>) => void;
}): { flush: (timeoutMs?: number) => Promise<void>; acknowledge: (requestId: unknown) => void } {
  const pending = new Map<string, () => void>();
  let sequence = 0;
  return {
    flush(timeoutMs = FILE_EDIT_FLUSH_TIMEOUT_MS) {
      sequence += 1;
      const requestId = `flush-${Date.now()}-${sequence}`;
      return new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          pending.delete(requestId);
          resolve();
        };
        const timer = setTimeout(() => {
          options.log("files.flush-timeout", { timeoutMs });
          done();
        }, timeoutMs);
        pending.set(requestId, done);
        let sent = false;
        try {
          sent = options.send(requestId);
        } catch {
          sent = false;
        }
        if (!sent) done();
      });
    },
    acknowledge(requestId) {
      if (typeof requestId === "string") pending.get(requestId)?.();
    }
  };
}

/**
 * Whether closing this window waits for the panel to save first. Only a plain
 * close (Cmd+W): while quitting or restarting for an update a prevented close
 * cancels the quit (2026-10-20), and both save through their own step.
 */
export function shouldFlushBeforeClose(state: {
  alreadyFlushed: boolean;
  quittingForUpdate: boolean;
  quitCleanupStarted: boolean;
  isMainWindow: boolean;
}): boolean {
  return !state.alreadyFlushed && !state.quittingForUpdate && !state.quitCleanupStarted && state.isMainWindow;
}

export type FrameNavigationDecision = "allow" | "block" | "open-outside";

/**
 * What happens when a frame inside the app's window navigates. The app's own
 * page never goes to a panel file. A page shown in the panel stays inside what
 * the panel granted it; a web link from that page itself (not from something it
 * embeds) opens in the system browser, at most once in a few seconds, so a page
 * cannot open tabs in a loop.
 */
export function filePreviewNavigationDecision(navigation: {
  url: string;
  isMainFrame: boolean;
  /** The frame is the panel's own frame (its parent is the app's page). */
  isPanelFrame: boolean;
  granted: boolean;
}, allowOutsideOpen: () => boolean): FrameNavigationDecision {
  if (navigation.isMainFrame) {
    return navigation.url.startsWith(`${FILE_PREVIEW_PROTOCOL}:`) ? "block" : "allow";
  }
  if (navigation.granted || navigation.url === "about:blank" || navigation.url.startsWith("about:srcdoc")) return "allow";
  if (!navigation.isPanelFrame || !/^https?:\/\//i.test(navigation.url)) return "block";
  return allowOutsideOpen() ? "open-outside" : "block";
}

/** One outside open per interval, for links and window.open from a panel page alike. */
export function createExternalOpenLimiter(now: () => number = Date.now, minIntervalMs = EXTERNAL_OPEN_MIN_INTERVAL_MS): () => boolean {
  let last = -Infinity;
  return () => {
    const at = now();
    if (at - last < minIntervalMs) return false;
    last = at;
    return true;
  };
}
