import { CheckIcon } from "@phosphor-icons/react";
import { Fragment, useEffect, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { HubAlertResult, UrgentAlertSettingsView, UrgentAlertUserRequest } from "../../../shared/urgentAlerts";

// What the Alerts page and its two connect dialogs share: asking the server,
// watching it while something happens elsewhere, and the dialogs' frame.

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

/**
 * The connect dialogs, one step at a time (the User, 2026-11-16): the steps
 * named under the title, only the current one on screen, Back on the left and
 * the step's own action where Next would be. The cross closes it.
 */
export function AlertsWizard(props: {
  open: boolean;
  title: string;
  steps: readonly string[];
  /** The step on screen, from 0; `steps.length` once every step is done. */
  current: number;
  /** While true (buying, saving) it cannot be closed. */
  busy?: boolean;
  testId?: string;
  initialFocus?: () => HTMLElement | null | undefined;
  /** Changes when what is on screen changes (another step, an account
   *  checked): the focus moves to the step's field marked
   *  data-wizard-autofocus, or else to its own action (never one marked
   *  data-wizard-no-autofocus, like buying: Enter must not spend money). */
  focusKey?: string;
  onClose: () => void;
  onBack?: () => void;
  backDisabled?: boolean;
  /** A short line beside Back. */
  note?: ReactNode;
  actions: ReactNode;
  children: ReactNode;
}): JSX.Element {
  const { initialFocus, steps, current, focusKey, open } = props;
  const body = useRef<HTMLDivElement>(null);
  const shownKey = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!open) {
      shownKey.current = undefined;
      return undefined;
    }
    // The first look is initialFocus's; later ones follow the step.
    if (shownKey.current === undefined) {
      shownKey.current = focusKey ?? "";
      return undefined;
    }
    if (shownKey.current === (focusKey ?? "")) return undefined;
    shownKey.current = focusKey ?? "";
    const timer = setTimeout(() => {
      const root = body.current?.closest<HTMLElement>("[data-slot='dialog-content']");
      if (!root) return;
      const field = root.querySelector<HTMLElement>("[data-wizard-autofocus]");
      const actions = [...root.querySelectorAll<HTMLButtonElement>("[data-slot='dialog-footer'] button:not(:disabled):not([data-wizard-no-autofocus])")];
      (field ?? actions[actions.length - 1] ?? root).focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [open, focusKey]);
  const stepWords = current < steps.length ? `Step ${current + 1} of ${steps.length}: ${steps[current]}` : "All steps done";
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !props.busy) props.onClose(); }}>
      <DialogContent
        className="gen-aws-dialog alerts-dialog alerts-wizard"
        // While it buys or saves, it cannot be closed: no cross to press.
        showCloseButton={!props.busy}
        data-testid={props.testId}
        onOpenAutoFocus={initialFocus ? (event) => {
          // Its field, or else the dialog itself while there is nothing to
          // press yet (an account being checked): the focus is inside, so a
          // menu closing behind it cannot take it back to the page.
          event.preventDefault();
          (initialFocus() ?? (event.currentTarget instanceof HTMLElement ? event.currentTarget : null))?.focus();
        } : undefined}
      >
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription className="sr-only" aria-live="polite">{stepWords}</DialogDescription>
          <ol className="alerts-wizard-steps" aria-hidden>
            {steps.map((label, index) => (
              <Fragment key={label}>
                {index > 0 ? <li className="alerts-wizard-sep" /> : null}
                <li className={`alerts-wizard-step is-${index < current ? "done" : index === current ? "now" : "later"}`}>
                  <span className="alerts-wizard-dot">{index < current ? <CheckIcon size={11} /> : index + 1}</span>
                  {label}
                </li>
              </Fragment>
            ))}
          </ol>
        </DialogHeader>
        <div ref={body} className="alerts-dialog-body">{props.children}</div>
        <DialogFooter>
          {props.onBack || props.note ? (
            <span className="alerts-wizard-left">
              {props.onBack ? <Button type="button" variant="outline" size="sm" disabled={props.backDisabled} onClick={props.onBack} data-testid="alerts-wizard-back">Back</Button> : null}
              {props.note ? <span className="gen-aws-dialog-note">{props.note}</span> : null}
            </span>
          ) : null}
          {props.actions}
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
