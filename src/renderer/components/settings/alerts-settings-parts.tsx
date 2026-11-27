import { WarningIcon, BellIcon, BellSlashIcon, CheckCircleIcon, MoonIcon, DotsThreeIcon, DeviceMobileIcon, PaperPlaneTiltIcon, HardDrivesIcon } from "@phosphor-icons/react";
import { useRef, useState, type ReactNode } from "react";
import { ALERT_CALL_CONTACT_HINT } from "../../../shared/alertCallContactText";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  ALERTS_FLOW_CHANNEL_WORD,
  ALERTS_STATUS_LABEL,
  alertsCallMinutes,
  alertsWaitChoices,
  type AlertsBand,
  type AlertsChannelStatus,
  type AlertsFlowChannel
} from "../../../shared/urgentAlertSettings";
import { AppSelect } from "../primitives";
import { Spinner } from "@/components/ui/spinner";
import { Delayed } from "@/components/ui/delayed";

const BAND_ICONS: Record<AlertsBand["kind"], typeof BellIcon> = {
  ok: CheckCircleIcon,
  bad: WarningIcon,
  warn: MoonIcon,
  off: BellSlashIcon,
  partial: BellIcon
};

/** The one line on top of the page: whether an alert reaches her now. */
export function AlertsStatusBand(props: { band: AlertsBand; action?: ReactNode }): JSX.Element {
  const Icon = BAND_ICONS[props.band.kind];
  return (
    <div className={`alerts-band is-${props.band.kind}`} role="status" data-testid="alerts-band">
      <span className="alerts-band-icon" aria-hidden><Icon size={18} /></span>
      <div className="alerts-band-text">
        <div className="alerts-band-title">{props.band.title}</div>
        <div className="alerts-band-detail">{props.band.detail}</div>
      </div>
      {props.action}
    </div>
  );
}

export function AlertsBandPlaceholder(props: { loading: boolean; error?: { code: string; message: string }; onRetry: () => void }): JSX.Element | null {
  // Reached, but not to be changed from here (another computer set the server
  // up), or reached, but too old for alerts: neither is "can't reach".
  const notOwner = props.error?.code === "access_denied";
  const older = /older than this app/.test(props.error?.message ?? "");
  // A check that answers quickly shows nothing; a failure shows at once.
  return props.loading ? (
    <Delayed>
      <div className="alerts-band is-off" role="status" data-testid="alerts-band">
        <span className="alerts-band-icon" aria-hidden><Spinner size={18} /></span>
        <div className="alerts-band-text"><div className="alerts-band-title">Checking your server…</div></div>
      </div>
    </Delayed>
  ) : (
    <div className="alerts-band is-bad" role="alert" data-testid="alerts-band">
      <span className="alerts-band-icon" aria-hidden><HardDrivesIcon size={18} /></span>
      <div className="alerts-band-text">
        <div className="alerts-band-title">{notOwner ? "Alerts are set up on another computer" : older ? "Your server hasn't updated yet" : "Can't reach your server"}</div>
        <div className="alerts-band-detail">{props.error ? `${props.error.message} ` : ""}{notOwner || older ? "" : "Alerts may not go out either."}</div>
      </div>
      <Button type="button" size="sm" onClick={props.onRetry}>Try again</Button>
    </div>
  );
}

/** What happens when an alert comes in, in order, with the wait to choose. */
export function AlertsFlow(props: {
  waitMinutes: number;
  telegram: AlertsFlowChannel;
  phone: AlertsFlowChannel;
  answerMode: boolean;
  busy: boolean;
  onWait: (minutes: number) => void;
}): JSX.Element {
  const calls = alertsCallMinutes(props.waitMinutes);
  const retry = calls[1] - calls[0];
  return (
    <div className="alerts-flow" data-testid="alerts-flow">
      <div className="alerts-flow-head">
        <span className="alerts-flow-title">What happens when an alert comes in</span>
        <AppSelect
          size="sm"
          value={String(props.waitMinutes)}
          ariaLabel="Call if you don't press Got it within"
          placeholder="Call after"
          disabled={props.busy}
          testId="alerts-wait"
          options={alertsWaitChoices(props.waitMinutes).map((minutes) => ({ value: String(minutes), label: `Call after ${minutes} min` }))}
          onValueChange={(value) => props.onWait(Number(value))}
        />
      </div>
      <ol className="alerts-chain" aria-label="When each step comes">
        <FlowNode icon={<BellIcon size={14} />} label="Alert" time={clock(0)} state="on" />
        <FlowEdge on={props.telegram === "ready"} />
        <FlowNode icon={<PaperPlaneTiltIcon size={14} />} label="Telegram" time={props.telegram === "ready" ? "at once" : ALERTS_FLOW_CHANNEL_WORD[props.telegram]} state={flowState(props.telegram)} />
        <FlowEdge label={`${props.waitMinutes} min`} on={props.phone === "ready"} />
        {calls.map((minutes, index) => (
          <FlowCall key={minutes} index={index} minutes={minutes} retry={retry} phone={props.phone} />
        ))}
      </ol>
      <div className="alerts-flow-foot">
        {props.answerMode ? "Answering a call counts as Got it." : "Got it in Telegram, 1 on a call, or Got it in the app stops it."}
      </div>
    </div>
  );
}

function FlowCall(props: { index: number; minutes: number; retry: number; phone: AlertsFlowChannel }): JSX.Element {
  const ready = props.phone === "ready";
  return <>
    {props.index > 0 ? <FlowEdge label={`${props.retry} min`} on={ready} /> : null}
    <FlowNode icon={<DeviceMobileIcon size={14} />} label={`Call ${props.index + 1}`} time={ready ? clock(props.minutes) : props.index === 0 ? ALERTS_FLOW_CHANNEL_WORD[props.phone as Exclude<AlertsFlowChannel, "ready">] : ""}
      // Later calls show no reason (the first one says it); a screen reader still hears it.
      spoken={!ready && props.index > 0 ? ALERTS_FLOW_CHANNEL_WORD[props.phone as Exclude<AlertsFlowChannel, "ready">] : undefined}
      state={props.index === 0 ? flowState(props.phone) : ready ? "on" : "off"} />
  </>;
}

/** What will happen is green, what will not is dim grey (the User,
 *  2026-11-16); a channel that is broken says so in red under it. */
function flowState(channel: AlertsFlowChannel): "on" | "off" | "bad" {
  return channel === "ready" ? "on" : channel === "broken" ? "bad" : "off";
}

/** Minutes after the alert as h:mm, as on the approved mockup (0:05). */
function clock(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

function FlowNode(props: { icon: ReactNode; label: string; time: string; spoken?: string; state: "on" | "off" | "bad" }): JSX.Element {
  return (
    <li className={`alerts-node is-${props.state}`}>
      <span className="alerts-node-dot" aria-hidden>{props.icon}</span>
      <span className="alerts-node-label">{props.label}</span>
      <span className="alerts-node-time">{props.time}{props.spoken ? <span className="sr-only">{props.spoken}</span> : null}</span>
    </li>
  );
}

function FlowEdge(props: { label?: string; on: boolean }): JSX.Element {
  return <li className={`alerts-edge is-${props.on ? "on" : "off"}`} aria-hidden>{props.label ? <span>{props.label}</span> : null}</li>;
}

export function AlertsStatusPill(props: { status: AlertsChannelStatus }): JSX.Element {
  return <span className={`alerts-pill is-${props.status}`} data-testid="alerts-status"><span className="alerts-pill-dot" aria-hidden />{ALERTS_STATUS_LABEL[props.status]}</span>;
}

export interface AlertsMenuItem {
  label: string;
  danger?: boolean;
  onSelect: () => void;
}

/** A channel's row: neutral tile, name with its status beside it, what it
 *  does and its last test, the action that comes next, and the rest in ⋯. */
export function AlertsChannelRow(props: {
  icon: ReactNode;
  name: string;
  status: AlertsChannelStatus;
  lines: Array<{ text: string; tone?: "error" | "warn" } | undefined>;
  action?: ReactNode;
  menu?: AlertsMenuItem[];
  testId: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  /** An item was chosen: what it opens (a dialog) takes the focus, so the
   *  closing menu does not hand it back to its button behind that dialog. */
  const picked = useRef(false);
  return (
    <div className="gen-row alerts-row" data-testid={props.testId}>
      <span className="alerts-tile" aria-hidden>{props.icon}</span>
      <div className="gen-row-text">
        <div className="alerts-name">{props.name} <AlertsStatusPill status={props.status} /></div>
        {props.lines.filter((line): line is { text: string; tone?: "error" | "warn" } => Boolean(line?.text)).map((line, index) => (
          <div key={line.text} className={`gen-row-desc${index === 0 && !line.tone ? " alerts-line-main" : ""}${line.tone ? ` alerts-line-${line.tone}` : ""}`} role={line.tone === "error" ? "alert" : undefined}>{line.text}</div>
        ))}
      </div>
      <div className="alerts-actions">
        {props.action}
        {props.menu?.length ? (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <button type="button" className="alerts-more" aria-label={`More for ${props.name}`} data-testid={`${props.testId}-more`}>
                <DotsThreeIcon size={16} aria-hidden />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="alerts-menu w-[200px] gap-0 p-[5px]" aria-label={`${props.name} options`}
              onCloseAutoFocus={(event) => { if (picked.current) event.preventDefault(); picked.current = false; }}>
              {props.menu.map((item) => (
                <button key={item.label} type="button" className={`alerts-menu-item${item.danger ? " is-danger" : ""}`} onClick={() => { picked.current = true; setOpen(false); item.onSelect(); }}>
                  {item.label}
                </button>
              ))}
            </PopoverContent>
          </Popover>
        ) : null}
      </div>
    </div>
  );
}

/** Under the Phone call row once calls have a number to come from: Add to
 *  contacts opens a contact card for that number with the system, which shows
 *  it before saving; Save logo is for a contact she saved before (Mia's brief,
 *  approved by the User, 2026-11-27). */
export const AlertsCallContactRow = (): JSX.Element => {
  const [pending, setPending] = useState<"contact" | "logo" | undefined>();
  const [error, setError] = useState<string | undefined>();
  const run = async (which: "contact" | "logo") => {
    setPending(which);
    setError(undefined);
    const result = await (which === "contact" ? window.consensus.openAlertCallContact() : window.consensus.saveAlertCallLogo()).catch((failure: unknown) => ({
      ok: false as const, message: failure instanceof Error ? failure.message : String(failure)
    }));
    setPending(undefined);
    if (!result.ok && "message" in result) setError(result.message);
  };
  return (
    <div className="gen-row alerts-row alerts-subrow" data-testid="alerts-call-contact">
      <span className="alerts-tile-space" aria-hidden />
      <div className="gen-row-text">
        <div className="gen-row-desc">{ALERT_CALL_CONTACT_HINT}</div>
        {error ? <div className="gen-row-desc alerts-line-error" role="alert">{error}</div> : null}
      </div>
      <div className="alerts-actions">
        <Button type="button" variant="outline" size="sm" disabled={Boolean(pending)} data-testid="alerts-call-logo-save" onClick={() => void run("logo")}>
          {pending === "logo" ? <Delayed><Spinner size={13} /></Delayed> : null}Save logo
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={Boolean(pending)} data-testid="alerts-call-contact-add" onClick={() => void run("contact")}>
          {pending === "contact" ? <Delayed><Spinner size={13} /></Delayed> : null}Add to contacts
        </Button>
      </div>
    </div>
  );
};
