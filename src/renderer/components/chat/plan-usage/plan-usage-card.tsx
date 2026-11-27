import {
  PLAN_USAGE_CLI_NAMES, planUsageHeadlineText, planUsagePercentText, planUsageResetText, planUsageWindowTitle, type MemberPlanUsage
} from "../../../../shared/planUsage";
import type { PlanUsageTone } from "../../../../shared/types";

type ShownPlanUsage = Exclude<MemberPlanUsage, { state: "none" }>;

interface PlanUsageCardProps {
  usage: ShownPlanUsage;
  /** The member's context line the app already reads ("62% left (…)"). */
  contextLabel?: string;
  /** When the card opened: resets read against it. */
  now: number;
}

/**
 * The ring's hover card (the User's design, 2026-11-27): the headline window
 * first with its reset, then the account's other windows one per line, then
 * the member's context. Limit reached says when the CLI takes requests again;
 * not read yet says when it will be.
 */
export const PlanUsageCard = ({ usage, contextLabel, now }: PlanUsageCardProps): JSX.Element => {
  const cli = PLAN_USAGE_CLI_NAMES[usage.provider];
  return (
    <>
      <PlanUsageCardLead usage={usage} cli={cli} now={now} />
      {usage.state === "read" && usage.others.length > 0 && (
        <div className="plan-usage-card-rows">
          {usage.others.map((window) => (
            <div key={window.id} className="plan-usage-card-line">
              <span className="plan-usage-card-name">{planUsageWindowTitle(window)}</span>
              <span className="plan-usage-card-value">{planUsagePercentText(window)}</span>
            </div>
          ))}
        </div>
      )}
      {contextLabel && <div className="plan-usage-card-foot">Context: {contextLabel}</div>}
    </>
  );
};

const PlanUsageCardLead = ({ usage, cli, now }: { usage: ShownPlanUsage; cli: string; now: number }): JSX.Element => {
  if (usage.state === "unread") {
    // Claude Code is read only through a member's live process; the others
    // are read on click.
    const when = usage.provider === "claude-code" ? "with the member's next reply" : "with the member's next reply, or now on click";
    return (
      <>
        <span className="plan-usage-card-lead">Usage not read yet</span>
        <span className="plan-usage-card-sub">{`${cli} reports it ${when}.`}</span>
      </>
    );
  }
  const headline = usage.headline;
  if (!headline) {
    return (
      <>
        <span className="plan-usage-card-lead">No limits reported</span>
        <span className="plan-usage-card-sub">{`${cli} reports no plan windows for this account.`}</span>
      </>
    );
  }
  const reset = planUsageResetText(headline.resetsAt, now);
  if (headline.tone === "reached") {
    const until = reset ? reset.replace(/^Resets /, "") : "the limit resets";
    const extraOff = usage.snapshot.facts.some((fact) => fact.label === "Extra usage" && fact.value === "Off");
    return (
      <>
        <span className="plan-usage-card-lead"><PlanUsageStatus tone="reached">{`Limit reached: ${planUsageWindowTitle(headline)}`}</PlanUsageStatus></span>
        <span className="plan-usage-card-sub">{`${cli} refuses requests until ${until}.${extraOff ? " Extra usage is off." : ""}`}</span>
      </>
    );
  }
  return (
    <>
      <span className="plan-usage-card-lead"><PlanUsageStatus tone={headline.tone}>{planUsageHeadlineText(usage.provider, headline)}</PlanUsageStatus></span>
      {reset && <span className="plan-usage-card-sub">{reset}</span>}
    </>
  );
};

/** Quiet status: a small dot and colored text where the CLI warns or
 *  refuses, plain text otherwise (never a filled pill). */
export const PlanUsageStatus = ({ tone, children }: { tone: PlanUsageTone; children: string }): JSX.Element =>
  tone === "normal"
    ? <>{children}</>
    : <span className={`plan-usage-status is-${tone}`}>{children}</span>;
