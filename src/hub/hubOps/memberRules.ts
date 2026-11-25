import type { HubDevice, HubMemberRules } from "../../shared/hubProtocol";
import { mainSessionParticipantId } from "../../shared/mainSession";
import { memberAsItRunsNow } from "../../shared/forkToNewChat";
import type { ChatParticipant, Conversation } from "../../shared/types";
import { cliModesTurnRefusal } from "../../shared/chatAccessModes";
import { HUB_MEMBER_RULES_DOCUMENT } from "./constants";
import type { HubOpsDependencies } from "./dependencies";

/** The User's rules for members. */
export class MemberRules {
  /** The User's rules for members, as her computer last published them
   *  (PUT /v1/member-rules); read again when published. */
  private memberRulesCache?: Promise<HubMemberRules | undefined>;

  constructor(private readonly deps: Pick<HubOpsDependencies, "storage">) {}

  memberRulesChanged(): void {
    this.memberRulesCache = undefined;
  }

  memberRules(): Promise<HubMemberRules | undefined> {
    this.memberRulesCache ??= this.deps.storage.hub().document(HUB_MEMBER_RULES_DOCUMENT).then((stored) => {
      const value = stored?.value as HubMemberRules | undefined;
      return value && value.version === 1 && value.roles && value.presets ? value : undefined;
    }, () => {
      this.memberRulesCache = undefined;
      return undefined;
    });
    return this.memberRulesCache;
  }

  /**
   * Why a turn of one of these members is not asked: its machine's program,
   * as the computer last said it (HubMemberRules.machineCliModes), would run
   * its stored mode otherwise than its controls say (cliModesTurnRefusal). A
   * machine the computer has not said anything of is not held back.
   */
  async cliModesRefusal(conversation: Conversation, participantIds: readonly string[], devices: HubDevice[]): Promise<string | undefined> {
    if (participantIds.length === 0) return undefined;
    const programs = (await this.memberRules())?.machineCliModes;
    if (!programs) return undefined;
    const members = Array.isArray(conversation.metadata?.participants) ? conversation.metadata.participants as ChatParticipant[] : [];
    // A member the main session made runs held to the main session's mode,
    // as on the computer (memberAsItRunsNow): judged as it runs.
    const mainId = mainSessionParticipantId(conversation.metadata);
    const mainSession = mainId ? members.find((item) => item?.id === mainId) : undefined;
    for (const participantId of participantIds) {
      const member = members.find((item) => item?.id === participantId);
      const machineId = member?.homeMachineId;
      if (!member || !machineId || typeof programs[machineId] !== "boolean") continue;
      const name = devices.find((item) => item.role === "machine" && item.machineId === machineId)?.name;
      const refusal = cliModesTurnRefusal(memberAsItRunsNow(member, mainSession), { name, support: programs[machineId] ? "supported" : "outdated" });
      if (refusal) return refusal;
    }
    return undefined;
  }
}
