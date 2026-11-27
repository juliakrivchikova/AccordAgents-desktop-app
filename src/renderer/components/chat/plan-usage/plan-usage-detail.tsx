import { ArrowClockwiseIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { ProgressBar } from "@/components/ui/progress-bar";
import {
  PLAN_USAGE_CLI_NAMES, planUsageAgeText, planUsagePercentText, planUsageResetText, type MemberPlanUsage
} from "../../../../shared/planUsage";
import type { ChatParticipant, PlanUsageRefreshResult, PlanUsageTone, PlanUsageWindow } from "../../../../shared/types";
import { ChatProviderMark } from "../chat-member-mark";
import { PlanUsageStatus } from "./plan-usage-card";

/** The kit's tones for a window's. */
export const PLAN_USAGE_KIT_TONE: Record<PlanUsageTone, "neutral" | "warning" | "danger"> = {
  normal: "neutral",
  warning: "warning",
  reached: "danger"
};

interface PlanUsageDetailProps {
  member: Pick<ChatParticipant, "kind" | "hostLabel">;
  usage: Exclude<MemberPlanUsage, { state: "none" }>;
  /** "62% left": the member's context. */
  contextLeft?: string;
  /** Where the figures come from: "This computer", "build-box (cloud)". */
  place: string;
  /** Why the machine's figures could not be read now: they are its last ones. */
  readFailed?: PlanUsageRefreshResult["failed"];
  now: number;
  /** A read is under way, or where to read is not known yet. */
  refreshDisabled: boolean;
  onRefresh: () => void;
}

/**
 * The ring's click (variant A, the User's choice of 2026-11-27): the
 * member's own account laid out as its CLI's /usage shows it, every window
 * with a bar and its reset, the account facts the CLI reports, the context,
 * and where and when the figures were read, with Refresh.
 */
export const PlanUsageDetail = (props: PlanUsageDetailProps): JSX.Element => {
  const { usage } = props;
  const cli = PLAN_USAGE_CLI_NAMES[usage.provider];
  const snapshot = usage.state === "read" ? usage.snapshot : undefined;
  const memberGroup = usage.state === "read" ? usage.group : undefined;
  const facts = [...(snapshot?.facts ?? []), ...(props.contextLeft ? [{ label: "Context", value: props.contextLeft }] : [])];
  return (
    <div className="plan-usage-detail" data-testid="chat-plan-usage-detail">
      <div className="plan-usage-detail-head">
        <ChatProviderMark member={props.member} className="is-mini" />
        <span className="plan-usage-detail-title">{`${cli} usage`}</span>
        {snapshot?.plan && <span className="plan-usage-detail-plan">{snapshot.plan}</span>}
      </div>
      {usage.state === "unread" && <p className="plan-usage-detail-note">Usage not read yet.</p>}
      {snapshot?.windows.filter((window) => !window.group).map((window) => <PlanUsageWindowRow key={window.id} window={window} now={props.now} />)}
      {snapshot?.groups?.map((group) => {
        const windows = snapshot.windows.filter((window) => window.group === group.name);
        const used = windows.some((window) => window.usedPercent !== undefined);
        return (
          <div key={group.name} className="plan-usage-detail-group">
            <div className="plan-usage-detail-group-label">
              {group.name}{group.name === memberGroup && <span className="plan-usage-detail-mine"> (this member's model)</span>}
            </div>
            {used
              ? windows.map((window) => <PlanUsageWindowRow key={window.id} window={window} now={props.now} />)
              : windows.map((window) => (
                <div key={window.id} className="plan-usage-detail-fact is-idle">
                  <span className="plan-usage-detail-fact-name">{window.label}</span>
                  <span className="plan-usage-detail-fact-value">Not used yet</span>
                </div>
              ))}
          </div>
        );
      })}
      {facts.length > 0 && (
        <div className="plan-usage-detail-facts">
          {facts.map((fact) => (
            <div key={fact.label} className="plan-usage-detail-fact">
              <span className="plan-usage-detail-fact-name">{fact.label}</span>
              <span className="plan-usage-detail-fact-value">{fact.value}</span>
            </div>
          ))}
        </div>
      )}
      <div className="plan-usage-detail-foot">
        <span className="plan-usage-detail-where">{placeText(props.place, props.readFailed, snapshot && planUsageAgeText(snapshot.observedAt, props.now))}</span>
        <Button variant="ghost" size="xs" disabled={props.refreshDisabled} onClick={props.onRefresh} data-testid="chat-plan-usage-refresh">
          <ArrowClockwiseIcon aria-hidden />
          Refresh
        </Button>
      </div>
    </div>
  );
};

/** "This computer, 1 min ago"; "build-box (cloud) is offline, read 2 h ago";
 *  "Your server is not reachable, read 2 h ago". */
function placeText(place: string, failed: PlanUsageRefreshResult["failed"], age: string | undefined): string {
  const why = failed === "machine-offline" ? `${place} is offline` : failed === "server-unreachable" ? "Your server is not reachable" : undefined;
  if (why) return age ? `${why}, read ${age}` : why;
  return age ? `${place}, ${age}` : place;
}

const PlanUsageWindowRow = ({ window, now }: { window: PlanUsageWindow; now: number }): JSX.Element => {
  const reset = planUsageResetText(window.resetsAt, now);
  return (
    <div className="plan-usage-detail-window">
      <div className="plan-usage-detail-window-top">
        <span className="plan-usage-detail-window-name">{window.label}</span>
        <span className="plan-usage-detail-window-value"><PlanUsageStatus tone={window.tone}>{planUsagePercentText(window, true)}</PlanUsageStatus></span>
      </div>
      <ProgressBar value={window.usedPercent ?? 0} tone={PLAN_USAGE_KIT_TONE[window.tone]} />
      {reset && <div className="plan-usage-detail-reset">{reset}</div>}
    </div>
  );
};
