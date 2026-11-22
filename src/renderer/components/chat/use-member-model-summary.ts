import { useMemo } from "react";

import { savedModelId } from "../../../shared/geminiModels";
import { normalizeChatReasoningEffort, reasoningEffortOptionsForProvider } from "../../../shared/reasoningEffort";
import type { ChatParticipant, ProviderModelCatalog, ProviderReasoningEffortOption } from "../../../shared/types";
import type { CliStartDefaults } from "../../../shared/cliStartDefaults";
import type { MachineListResult } from "../../../shared/machineLink";
import { memberModelName, useMemberModelCatalog } from "./chat-member-model-name";
import { useCliStartDefaults } from "./use-cli-start-defaults";

export type ModelSummaryMember = Pick<ChatParticipant, "kind"> &
  Partial<Pick<ChatParticipant, "hostId" | "hostLabel" | "hostVendor" | "model" | "reasoningEffort" | "homeMachineId" | "cloudRun">>;

/** What a member runs on, as its composer's chip names it: the model by its
 *  name in the CLI's list ("Opus 5.5", never the id "opus"), and its effort
 *  when one is set (its own, else the one the User's config starts the CLI
 *  with where it runs). */
export interface MemberModelSummary {
  model: string;
  effort?: string;
}

/** The effort a member runs at, by its name in the list of its model's
 *  efforts (the CLI's own list when the model has none): its own, else for
 *  a member without a model of its own the one her config sets. */
export function memberEffortLabel(
  member: ModelSummaryMember,
  catalog: ProviderModelCatalog | undefined,
  start: CliStartDefaults | undefined
): string | undefined {
  const model = savedModelId(member.kind, member.model);
  const listed = catalog?.models.find((item) => model ? item.id === model : item.recommended && item.source !== "configured");
  const efforts: readonly ProviderReasoningEffortOption[] = listed?.supportedReasoningEfforts?.length
    ? listed.supportedReasoningEfforts
    : reasoningEffortOptionsForProvider(member.kind);
  const has = (id: string | undefined): id is string => Boolean(id) && efforts.some((option) => option.id === id);
  const own = normalizeChatReasoningEffort(member.reasoningEffort, member.kind);
  const effort = has(own) ? own : !model && !member.hostId && has(start?.reasoningEffort) ? start?.reasoningEffort : undefined;
  return effort ? efforts.find((option) => option.id === effort)?.label ?? effort : undefined;
}

/** memberModelName and memberEffortLabel for a row, from the CLI's list (one
 *  read shared by every control that shows it) and the machines the panel
 *  read once. */
export function useMemberModelSummary(member: ModelSummaryMember, machines: MachineListResult): MemberModelSummary {
  const { catalog } = useMemberModelCatalog(member);
  const start = useCliStartDefaults({ kind: member.kind, homeMachineId: member.homeMachineId, cloudRun: member.cloudRun }, machines);
  return useMemo(() => {
    const model = memberModelName({ ...member, model: savedModelId(member.kind, member.model) }, catalog, start);
    const effort = memberEffortLabel(member, catalog, start);
    return effort ? { model, effort } : { model };
  }, [catalog, start, member]);
}
