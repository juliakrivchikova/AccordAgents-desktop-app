import { useState } from "react";
import { HoverCard } from "radix-ui";
import { ProgressRing } from "@/components/ui/progress-ring";
import { formatContextUsageLabel } from "../../../../shared/agentContext";
import { savedModelId } from "../../../../shared/geminiModels";
import { memberPlanUsage, planUsageHeadlineText } from "../../../../shared/planUsage";
import type { AgentContextUsage, ChatParticipant, PlanUsageRefreshRequest, PlanUsageRefreshResult } from "../../../../shared/types";
import { useMemberModelCatalog } from "../chat-member-model-name";
import { defaultModelOf } from "../chat-model-access-picker";
import { ComposerMenu } from "../composer-menu";
import { machineIdOf, machineOf, useCliStartDefaults, useMachineList } from "../use-cli-start-defaults";
import { PlanUsageCard } from "./plan-usage-card";
import { PLAN_USAGE_KIT_TONE, PlanUsageDetail } from "./plan-usage-detail";
import { refreshPlanUsage, usePlanUsageView } from "./use-plan-usage";

interface MemberPlanUsageRingProps {
  participant: Pick<ChatParticipant, "kind" | "model" | "hostId" | "hostLabel" | "hostVendor" | "homeMachineId" | "cloudRun">;
  contextUsage?: AgentContextUsage;
}

/**
 * How much of its plan the member's CLI account has used, as a ring left of
 * the model in the composer's context row (the User's design, 2026-11-27):
 * the hover card after 500ms, the account as its CLI's /usage shows it on
 * click. The figures come from where the member runs: this computer's CLI,
 * or its machine's through the User's server, so a cloud member's ring is a
 * local one's. No ring for a member without plan limits (an added provider,
 * an API key).
 */
export const MemberPlanUsageRing = ({ participant, contextUsage }: MemberPlanUsageRingProps): JSX.Element | null => {
  const view = usePlanUsageView();
  const machines = useMachineList();
  const [hoverOpen, setHoverOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [readFailed, setReadFailed] = useState<PlanUsageRefreshResult["failed"]>();
  const [openedAt, setOpenedAt] = useState(() => Date.now());
  // The model it runs, resolved as its model picker resolves it: its own, else
  // the one its CLI starts in where it runs (a machine's as that machine says
  // it, which this computer's list may not have), else this computer's
  // default. The windows and the Codex bucket that count for it follow it.
  const { catalog } = useMemberModelCatalog(participant);
  const start = useCliStartDefaults(participant, machines);
  const onMachine = Boolean(participant.homeMachineId || participant.cloudRun);
  const startModel = participant.hostId ? undefined : start?.model;
  const model = savedModelId(participant.kind, participant.model)
    ?? (onMachine && startModel ? startModel : defaultModelOf(catalog, startModel)?.id);
  const machineId = onMachine ? machineIdOf(participant, machines) : undefined;
  const snapshots = onMachine ? (machineId ? view.machines[machineId]?.snapshots : undefined) : view.local;
  const usage = memberPlanUsage({ ...participant, model }, snapshots);
  if (usage.state === "none") return null;

  // A member on a machine not known here yet has nowhere to be read: never
  // this computer's CLI in its place.
  const request: PlanUsageRefreshRequest | undefined = onMachine && !machineId ? undefined : { provider: usage.provider, ...(machineId ? { machineId } : {}) };
  const opened = (): void => {
    setOpenedAt(Date.now());
    if (request) void refreshPlanUsage(request).then(setReadFailed);
  };
  const refreshNow = (): void => {
    if (!request) return;
    setRefreshing(true);
    void refreshPlanUsage({ ...request, force: true }).then((failed) => {
      setRefreshing(false);
      setReadFailed(failed);
      setOpenedAt(Date.now());
    });
  };
  const machineName = machineOf(machines, machineId)?.name;
  const place = !onMachine ? "This computer" : `${machineName ?? "Its machine"}${participant.cloudRun ? " (cloud)" : ""}`;
  const headline = usage.state === "read" ? usage.headline : undefined;
  const title = usage.state === "unread" ? "Plan usage not read yet"
    : headline ? `Plan usage: ${planUsageHeadlineText(usage.provider, headline)}` : "Plan usage";
  const contextLabel = contextUsage ? formatContextUsageLabel(contextUsage) : undefined;
  const contextLeft = contextUsage ? `${Math.max(0, Math.min(100, 100 - contextUsage.percentage))}% left` : undefined;

  return (
    <HoverCard.Root
      open={hoverOpen && !menuOpen}
      onOpenChange={(open) => {
        // While the menu is open the card stays shut and is not armed to come
        // back when the menu closes.
        if (open && menuOpen) return;
        setHoverOpen(open);
        if (open) opened();
      }}
      openDelay={500}
      closeDelay={60}
    >
      <HoverCard.Trigger asChild>
        <span className="plan-usage-anchor">
          <ComposerMenu
            testId="chat-plan-usage"
            title={title}
            width={320}
            align="end"
            bare
            triggerClassName="plan-usage-ring-button"
            onOpenChange={(open) => {
              // Radix is not told when the card is shut from here: its open
              // state is dropped on any change of the menu, so the card never
              // pops back up after the menu closes.
              setHoverOpen(false);
              setMenuOpen(open);
              if (open) opened();
            }}
            label={<ProgressRing value={headline ? headline.usedPercent ?? 0 : undefined} tone={PLAN_USAGE_KIT_TONE[usage.state === "read" ? usage.tone : "normal"]} />}
          >
            {() => (
              <PlanUsageDetail member={participant} usage={usage} contextLeft={contextLeft} place={place} readFailed={readFailed} now={openedAt}
                refreshDisabled={refreshing || !request} onRefresh={refreshNow} />
            )}
          </ComposerMenu>
        </span>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content side="top" align="end" sideOffset={8} collisionPadding={8} className="chat-agent-card plan-usage-card"
          data-testid="chat-plan-usage-card">
          <PlanUsageCard usage={usage} contextLabel={contextLabel} now={openedAt} />
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
};
