import { Check } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import type { HubAlertResult, UrgentAlertSettingsView, UrgentAlertUserRequest } from "../../../shared/urgentAlerts";

// What the Alerts page and its two connect dialogs share: asking the server,
// watching it while something happens elsewhere, and a step of a dialog.

export async function alertRequest<T>(request: UrgentAlertUserRequest): Promise<HubAlertResult<T>> {
  try {
    return await window.consensus.urgentAlertRequest(request) as HubAlertResult<T>;
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
 *  the last answer, so a slow server is never asked twice at once. */
export function useSettingsWatch(active: boolean, onSettings: (settings: UrgentAlertSettingsView) => void): void {
  useEffect(() => {
    if (!active) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = (): void => {
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
  }, [active, onSettings]);
}
