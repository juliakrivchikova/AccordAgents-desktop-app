import { breadcrumbsIntegration, init } from "@sentry/electron/renderer";
import { scrubCrashReportBreadcrumb } from "../../shared/crashReportPrivacy";

/**
 * The window's half of crash reporting: it captures renderer errors and hands
 * them to the main process, which scrubs and sends them. Started only when
 * the main process launched with reports on.
 */
export function startRendererCrashReporting(): void {
  if (window.consensus?.crashReportsActive !== true) {
    return;
  }
  try {
    init({
      // Console output can quote prompts and replies; the click trail names
      // chats and members.
      integrations: [breadcrumbsIntegration({ console: false, dom: false })],
      beforeBreadcrumb: (breadcrumb) => scrubCrashReportBreadcrumb(breadcrumb)
    });
  } catch {
    // Reporting must never keep the window from starting.
  }
}
