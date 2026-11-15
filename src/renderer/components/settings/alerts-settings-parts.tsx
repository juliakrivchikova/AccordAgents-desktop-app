import { AlertTriangle, Bell, BellOff, CircleCheck, Loader2, Moon, MoreHorizontal, Phone, Send, Server } from "lucide-react";
import { useState, type ReactNode } from "react";
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

const BAND_ICONS: Record<AlertsBand["kind"], typeof Bell> = {
  ok: CircleCheck,
  bad: AlertTriangle,
  warn: Moon,
  off: BellOff,
  partial: Bell
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

export function AlertsBandPlaceholder(props: { loading: boolean; error?: string; onRetry: () => void }): JSX.Element {
  return props.loading ? (
    <div className="alerts-band is-off" role="status" data-testid="alerts-band">
      <span className="alerts-band-icon" aria-hidden><Loader2 size={18} className="gen-aws-spinner" /></span>
      <div className="alerts-band-text"><div className="alerts-band-title">Checking your server…</div></div>
    </div>
  ) : (
    <div className="alerts-band is-bad" role="alert" data-testid="alerts-band">
      <span className="alerts-band-icon" aria-hidden><Server size={18} /></span>
      <div className="alerts-band-text">
        <div className="alerts-band-title">Can't reach your server</div>
        <div className="alerts-band-detail">{props.error ? `${props.error} ` : ""}Alerts may not go out either.</div>
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
        <FlowNode icon={<Bell size={14} />} label="Alert" time={clock(0)} />
        <FlowEdge off={props.telegram !== "ready"} />
        <FlowNode icon={<Send size={14} />} label="Telegram" time={props.telegram === "ready" ? "at once" : ALERTS_FLOW_CHANNEL_WORD[props.telegram]} off={props.telegram !== "ready"} />
        <FlowEdge label={`${props.waitMinutes} min`} off={props.phone !== "ready"} />
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
    {props.index > 0 ? <FlowEdge label={`${props.retry} min`} off={!ready} /> : null}
    <FlowNode icon={<Phone size={14} />} label={`Call ${props.index + 1}`} time={ready ? clock(props.minutes) : props.index === 0 ? ALERTS_FLOW_CHANNEL_WORD[props.phone as Exclude<AlertsFlowChannel, "ready">] : ""} off={!ready} />
  </>;
}

/** Minutes after the alert as h:mm, as on the approved mockup (0:05). */
function clock(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

function FlowNode(props: { icon: ReactNode; label: string; time: string; off?: boolean }): JSX.Element {
  return (
    <li className={`alerts-node${props.off ? " is-off" : ""}`}>
      <span className="alerts-node-dot" aria-hidden>{props.icon}</span>
      <span className="alerts-node-label">{props.label}</span>
      <span className="alerts-node-time">{props.time}</span>
    </li>
  );
}

function FlowEdge(props: { label?: string; off?: boolean }): JSX.Element {
  return <li className={`alerts-edge${props.off ? " is-off" : ""}`} aria-hidden>{props.label ? <span>{props.label}</span> : null}</li>;
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
                <MoreHorizontal size={16} aria-hidden />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="alerts-menu w-[200px] gap-0 p-[5px]" aria-label={`${props.name} options`}>
              {props.menu.map((item) => (
                <button key={item.label} type="button" className={`alerts-menu-item${item.danger ? " is-danger" : ""}`} onClick={() => { setOpen(false); item.onSelect(); }}>
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
