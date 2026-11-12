import os from "node:os";
import { app } from "electron";
import type * as SentryMain from "@sentry/electron/main";
import { CRASH_REPORT_EXCLUDED_INTEGRATIONS, scrubCrashReportBreadcrumb, scrubCrashReportEvent, scrubSerializedUsageLogs, scrubUsageLog } from "../../shared/crashReportPrivacy";
import { crashReportReleaseName, type UsageSignalAttributes } from "../../shared/usageSignals";
import { discardCrashReportData } from "./crashReportPreferences";

// The project's ingest key. A DSN only allows sending events to this project,
// so it ships inside the app like every client-side Sentry key.
export const CRASH_REPORT_DSN = "https://e312c8c90f8caaf73fcdcc0485b4edb1@o4512180528611328.ingest.de.sentry.io/4512180670365776";

/** Tells the window's preload that reports are running for this launch; the
 *  sandboxed preload cannot import it, so it repeats the literal. */
export const CRASH_REPORTS_ACTIVE_ARG = "--accordagents-crash-reports=on";

/** A desktop left open for days still counts as active every day. */
const SESSION_ROLLOVER_MS = 24 * 60 * 60 * 1000;
/** How long a usage signal's send may take before it is left to the queue. */
const USAGE_SIGNAL_FLUSH_MS = 5000;

let active = false;
// Loaded only when reports are on, so a launch with them off pays nothing.
let Sentry: typeof SentryMain | undefined;
let rolloverTimer: ReturnType<typeof setInterval> | undefined;

export function crashReportEnvironment(isPackaged: boolean, version: string): string {
  if (!isPackaged) return "development";
  return version.includes("-beta") ? "beta" : "production";
}

export interface CrashReportingStartResult {
  active: boolean;
  loadMs?: number;
  error?: string;
}

/**
 * Starts error and session reporting. Must run before the app is ready: the
 * SDK registers the privileged scheme the window reports through.
 */
export function startCrashReporting(installId: string): CrashReportingStartResult {
  if (active) {
    return { active: true };
  }
  const homeDir = os.homedir();
  const loadStarted = Date.now();
  try {
    const sdk: typeof SentryMain = require("@sentry/electron/main");
    Sentry = sdk;
    const loadMs = Date.now() - loadStarted;
    sdk.init({
      dsn: CRASH_REPORT_DSN,
      environment: crashReportEnvironment(app.isPackaged, app.getVersion()),
      // The system is part of the release so active installs can be counted
      // per system: Sentry groups sessions only by release and environment.
      release: crashReportReleaseName(app.getVersion(), process.platform),
      sendDefaultPii: false,
      includeLocalVariables: false,
      attachScreenshot: false,
      initialScope: { user: { id: installId } },
      // Without this the SDK adds sentry-trace and baggage headers (project
      // key, release, trace id) to every request the app makes: providers,
      // AWS, the relay. Nothing outside Sentry gets them.
      tracePropagationTargets: [],
      // The offline queue resends on its own timer, past the client; once
      // reports are off it neither sends nor keeps anything.
      transportOptions: {
        shouldSend: () => active,
        shouldStore: () => active
      },
      integrations: (defaults) => [
        ...defaults.filter((integration) => !CRASH_REPORT_EXCLUDED_INTEGRATIONS.has(integration.name)
          && integration.name !== "MainProcessSession" && integration.name !== "ChildProcess"),
        // Sent when the app starts, not only when it quits, so a running
        // desktop is counted even if it is never closed.
        sdk.mainProcessSessionIntegration({ sendOnCreate: true }),
        // Without crash dumps, a crashed window or helper is reported by its
        // exit reason alone.
        sdk.childProcessIntegration({ events: ["abnormal-exit", "launch-failed", "integrity-failure", "crashed", "oom"] })
      ],
      beforeSend: (event) => scrubCrashReportEvent(event, homeDir),
      // Usage signals are logs, so they never show among the errors; no
      // other log leaves the computer.
      enableLogs: true,
      beforeSendLog: (log) => scrubUsageLog(log),
      beforeBreadcrumb: (breadcrumb) => scrubCrashReportBreadcrumb(breadcrumb, homeDir)
    });
    // Every log on its way out, whatever path it took (the window's logs and
    // scope attributes skip beforeSendLog), is checked again.
    sdk.getClient()?.on("beforeEnvelope", (envelope) => {
      const items = envelope[1] as unknown as Array<[{ type?: string; item_count?: number }, { items?: unknown[] }]>;
      for (let index = items.length - 1; index >= 0; index -= 1) {
        const [header, payload] = items[index];
        if (header?.type !== "log") continue;
        const logs = Array.isArray(payload?.items) ? scrubSerializedUsageLogs(payload.items) : [];
        if (logs.length === 0) {
          items.splice(index, 1);
        } else {
          payload.items = logs;
          header.item_count = logs.length;
        }
      }
    });
    active = true;
    rolloverTimer = setInterval(() => {
      if (!active || !Sentry) return;
      Sentry.endSession();
      Sentry.startSession();
      Sentry.captureSession();
    }, SESSION_ROLLOVER_MS);
    rolloverTimer.unref?.();
    return { active: true, loadMs };
  } catch (error) {
    // A client may already be installed when init throws part way.
    void Sentry?.close(0).catch(() => false);
    return { active: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function crashReportingActive(): boolean {
  return active;
}

/**
 * Sends one usage signal as an info log and sends it on at once (the SDK
 * otherwise holds logs for a while, and the app may quit first). False when
 * reports are off: nothing is sent or kept, and the caller does not count the
 * signal as sent.
 */
export function sendUsageSignal(name: string, attributes: UsageSignalAttributes): boolean {
  if (!active || !Sentry) return false;
  try {
    Sentry.logger.info(name, attributes);
    void Sentry.flush(USAGE_SIGNAL_FLUSH_MS).catch(() => false);
    return true;
  } catch {
    return false;
  }
}

/** Turning reports off takes effect at once: nothing more is sent from this
 *  launch, including what the window reports, and nothing kept for later. */
export async function stopCrashReporting(userDataDir: string): Promise<void> {
  active = false;
  if (rolloverTimer) clearInterval(rolloverTimer);
  rolloverTimer = undefined;
  if (Sentry) {
    const client = Sentry.getClient();
    if (client) client.getOptions().enabled = false;
    await Sentry.close(2000).catch(() => false);
  }
  try {
    discardCrashReportData(userDataDir);
  } catch {
    // Whatever is left cannot be sent: the transport refuses while off, and a
    // launch with reports off removes it.
  }
}
