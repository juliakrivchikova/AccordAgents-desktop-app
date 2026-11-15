import { Check } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import type { HubAlertResult, UrgentAlertSettingsView, UrgentAlertUserRequest } from "../../../shared/urgentAlerts";

// What the Alerts page and its two connect dialogs share: asking the server,
// watching it while something happens elsewhere, and a step of a dialog.

export async function alertRequest<T>(request: UrgentAlertUserRequest): Promise<HubAlertResult<T>> {
  try {
    const result = await window.consensus.urgentAlertRequest(request) as HubAlertResult<T>;
    // A server not yet updated to this app knows the alerts but not this step.
    if (!result.ok && /^Unknown alert action/.test(result.error.message)) {
      return { ok: false, error: { code: result.error.code, message: "Your server is older than this app and can't do this yet; it will once it updates." } };
    }
    return result;
  } catch (error) {
    return { ok: false, error: { code: "server_unavailable", message: error instanceof Error ? error.message : String(error) } };
  }
}

export function AlertsStep(props: { n: number; state: "done" | "now" | "later"; title: ReactNode; children?: ReactNode }): JSX.Element {
  return (
    <li className={`alerts-step is-${props.state}`} aria-current={props.state === "now" ? "step" : undefined}>
      <span className="alerts-step-mark" aria-hidden>{props.state === "done" ? <Check size={13} /> : props.n}</span>
      <div className="alerts-step-text">
        <div className="alerts-step-title">
          {props.title}
          <span className="sr-only">{props.state === "done" ? " (done)" : props.state === "later" ? " (not yet)" : ""}</span>
        </div>
        {props.children}
      </div>
    </li>
  );
}

/** Asks the server again every 1.5 s while `active`: the next look only after
 *  the last answer, so a slow server is never asked twice at once. With
 *  `until`, it stops then, answered or not (a server that never answers is
 *  not asked for ever). */
export function useSettingsWatch(active: boolean, onSettings: (settings: UrgentAlertSettingsView) => void, until?: number): void {
  useEffect(() => {
    if (!active) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = (): void => {
      if (until !== undefined && Date.now() > until) return;
      timer = setTimeout(() => {
        void alertRequest<UrgentAlertSettingsView>({ action: "settings" }).then((result) => {
          if (stopped) return;
          if (result.ok) onSettings(result.value);
          look();
        });
      }, 1_500);
    };
    look();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, onSettings, until]);
}
