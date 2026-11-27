import { app, BrowserWindow } from "electron";
import { flushRendererFileEdits } from "./coreServices";
import type { DesktopApp } from "./desktopApp";

/** How long a quit may clean up before the app goes anyway. */
const QUIT_CLEANUP_MS = 5_000;

/** How long a quit lets the members it stops end their turns by themselves
 *  (a reply that was just written is kept whole), and then how long it waits
 *  for those ends to reach the User's server; together well inside
 *  QUIT_CLEANUP_MS. What is left goes at the next start. */
const QUIT_TURNS_END_MS = 1_000;

const QUIT_SERVER_SEND_MS = 1_500;

/** How long after its last quit call a quit that ran its steps may take to
 *  reach will-quit before it counts as cancelled. */
const QUIT_CANCEL_DETECT_MS = 5_000;

/** Ends members' turns and closes everything before the app goes. */
export function listenToQuit(desktopApp: DesktopApp): void {
  app.on("before-quit", (event) => {
    desktopApp.debugLogService.writeNow("app-quit.before-quit", {
      forUpdate: desktopApp.quittingForUpdate,
      cleanupStarted: desktopApp.quitCleanupStarted,
      cleanupFinished: desktopApp.quitCleanupFinished,
      heldForConfirmation: desktopApp.quitConfirmation.holding(),
      windows: BrowserWindow.getAllWindows().length
    });
    if (desktopApp.quittingForUpdate) {
      return;
    }
    // The User is being asked whether to stop the terminal's commands; the
    // quit goes on (or not) from her answer.
    if (desktopApp.quitConfirmation.holding()) {
      event.preventDefault();
      return;
    }
    if (desktopApp.quitCleanupFinished) {
      return;
    }
    event.preventDefault();
    if (desktopApp.quitCleanupStarted) {
      return;
    }
    desktopApp.quitCleanupStarted = true;
    const cleanupStartedAt = Date.now();
    let cleanupDone = false;
    const cleanup = Promise.allSettled([
      // The file panel saves first; its unsaved text is also in userData if it cannot.
      flushRendererFileEdits(desktopApp),
      stopMembersThenServerLink(desktopApp),
      desktopApp.scriptService.stop().then(() => desktopApp.appMcpService.stop())
    ]).then(() => { cleanupDone = true; });
    desktopApp.quitCleanupRun = cleanup;
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, QUIT_CLEANUP_MS));
    void Promise.race([cleanup, timeout]).finally(() => {
      desktopApp.debugLogService.writeNow("app-quit.cleanup-finished", { ms: Date.now() - cleanupStartedAt, timedOut: !cleanupDone });
      desktopApp.quitCleanupFinished = true;
      // Quit again only after Electron's own quit call has returned. A quit
      // from the Quit menu (Cmd+Q), the Dock or a signal starts in native code,
      // so this promise can settle while that call is still emitting
      // before-quit: a nested app.quit() then runs inside it, and the outer call
      // overwrites the quitting state with "cancelled" on return. The windows
      // close and the app keeps running with none (2026-10-20, the User's
      // Cmd+Q at 08:45). The immediate runs at the loop's next wakeup, which
      // the quit's own file and network work brings at once (0 ms measured).
      setImmediate(() => {
        app.quit();
        // Nothing says a quit was cancelled; one that has not reached
        // will-quit by then was.
        if (desktopApp.quitCancelTimer) clearTimeout(desktopApp.quitCancelTimer);
        desktopApp.quitCancelTimer = setTimeout(() => {
          // Only with a window still open: one whose windows are gone is still
          // quitting, however slowly, and must not start anything again.
          const open = BrowserWindow.getAllWindows().some((window) => !window.isDestroyed());
          if (open) quitWasCancelled(desktopApp, "no will-quit");
          else desktopApp.debugLogService.writeNow("app-quit.slow", { afterMs: QUIT_CANCEL_DETECT_MS });
        }, QUIT_CANCEL_DETECT_MS);
        desktopApp.quitCancelTimer.unref?.();
      });
    });
  });

  app.on("will-quit", () => {
    desktopApp.debugLogService.writeNow("app-quit.will-quit", { forUpdate: desktopApp.quittingForUpdate });
    if (desktopApp.quitCancelTimer) clearTimeout(desktopApp.quitCancelTimer);
    desktopApp.quitCancelTimer = undefined;
    // Here and not in before-quit, which an update's restart skips: every
    // shell in the terminal panel gets its hangup on any kind of quit.
    desktopApp.terminalService.shutdown();
    // The speech model leaves memory with the app (its engine would also stop
    // on its own once the app is gone).
    void desktopApp.speechToTextService.shutdown();
    desktopApp.localCliSignInService.shutdown();
    // Its live link to the server and its timers end with the app.
    desktopApp.planUsageLink.stop();
    void desktopApp.cliMemorySync?.stop();
  });

  app.on("quit", (_event, exitCode) => {
    desktopApp.debugLogService.writeNow("app-quit.quit", { exitCode, forUpdate: desktopApp.quittingForUpdate });
  });
}

/**
 * Quitting stops the members as a machine does (src/machine/main.ts): their
 * turns end, how they ended goes to the User's server while the link still
 * stands, and only then does the link close. The phone sees them end at
 * once; before, the link closed alongside and a turn's end waited for the
 * app's next start (2026-11-22). No turn the server asks starts meanwhile.
 * Closing the members' processes runs alongside: it can take seconds.
 */
async function stopMembersThenServerLink(desktopApp: DesktopApp): Promise<void> {
  desktopApp.chatService.beginQuit();
  const membersClosed = desktopApp.cliAgentRunner.shutdownWarmAgents();
  try {
    const ended = await desktopApp.chatService.waitForRunsToEnd(QUIT_TURNS_END_MS);
    // The rest end now, as the next start would have closed them.
    let interrupted = 0;
    let endError: string | undefined;
    if (!ended) {
      interrupted = await desktopApp.chatService.endTurnsForQuit().catch((error: unknown) => {
        endError = error instanceof Error ? error.message : String(error);
        return 0;
      });
    }
    const queued = await desktopApp.serverChatLink.waitUntilSent(QUIT_SERVER_SEND_MS);
    desktopApp.debugLogService.writeNow("app-quit.server-sent", { turnsEnded: ended, interrupted, queued: queued ?? null, ...(endError ? { endError } : {}) });
  } finally {
    await desktopApp.serverChatLink.stop();
  }
  await membersClosed;
}

/**
 * A quit that ran its steps and then did not happen (a window kept its page
 * from unloading, or the native quit was cancelled): the app goes on as it
 * was. What the steps stopped starts again, and turns run again: left
 * quitting, it took no turn the server asked and resumed no requester, with
 * its link to the server closed (2026-11-22 review).
 */
export function quitWasCancelled(desktopApp: DesktopApp, reason: string): void {
  if (desktopApp.quitCancelTimer) clearTimeout(desktopApp.quitCancelTimer);
  desktopApp.quitCancelTimer = undefined;
  // Only a quit that ran its steps and closes the windows can be cancelled.
  if (!desktopApp.quitCleanupStarted || !desktopApp.quitCleanupFinished) return;
  desktopApp.debugLogService.writeNow("app-quit.cancelled", { reason });
  desktopApp.quitCleanupStarted = false;
  desktopApp.quitCleanupFinished = false;
  // The window's close ran before its page kept itself open, and let go of
  // it as the main window: it is that again, so it gets the chat's updates.
  if ((!desktopApp.mainWindow || desktopApp.mainWindow.isDestroyed()) && desktopApp.mainWindowLetGoByQuit && !desktopApp.mainWindowLetGoByQuit.isDestroyed()) {
    desktopApp.mainWindow = desktopApp.mainWindowLetGoByQuit;
  }
  desktopApp.mainWindowLetGoByQuit = undefined;
  // The next quit asks about the terminal's commands again.
  desktopApp.quitConfirmation.revoke();
  // Once the quit's own steps have really ended (they may outlast its time
  // limit): started earlier, their stops would close what starts here.
  const cleaned = desktopApp.quitCleanupRun ?? Promise.resolve();
  desktopApp.quitCleanupRun = undefined;
  void cleaned.then(async () => {
    // A quit begun again meanwhile owns what runs now.
    if (desktopApp.quitCleanupStarted) return;
    desktopApp.chatService.endQuit();
    const failed = (part: string) => (error: unknown) => {
      void desktopApp.debugLogService.write("app-quit.cancelled.restart-error", { part, message: error instanceof Error ? error.message : String(error) });
    };
    // As the app starts: its local API before the scripts that call it.
    await desktopApp.appMcpService.start().catch(failed("app tools"));
    if (desktopApp.quitCleanupStarted) return;
    void desktopApp.scriptService.start().catch(failed("scripts"));
    void desktopApp.serverChatLink.start().catch(failed("server link"));
  });
}
