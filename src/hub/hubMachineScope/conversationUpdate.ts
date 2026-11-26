import { mainSessionParticipantId } from "../../shared/mainSession";
import type { ChatAppToolApprovalPolicy, ChatParticipant, Conversation } from "../../shared/types";
import { keepRequestRight } from "./askRights";
import { approvedRequests, leaveGiven } from "./grants";
import { additionAllowed, isPolicyFor, removalAllowed } from "./memberChanges";
import {
  keepElsewhere, keepHome, keepRole, latestPlanAnswersOnly, namesNewChat, withDelegator, withoutComputerOnlyFields
} from "./memberFields";
import { keepRights } from "./memberRights";
import { handleKey, participantsOf, policiesOf, runsOnMachine } from "./records";
import type { MachineScopeContext, MachineScopedUpdate, MemberChanges, Update } from "./types";

export function scopeMachineConversationUpdate(conversation: Conversation, update: Update, machineId: string | undefined, context: MachineScopeContext = {}): MachineScopedUpdate {
  const refused: string[] = [];
  const scoped: Update = {};
  const current = (conversation.metadata ?? {}) as Record<string, unknown>;
  const before = participantsOf(current.participants);
  const beforeById = new Map(before.map((participant) => [participant.id, participant]));
  const ownBefore = before.filter((participant) => runsOnMachine(participant, machineId));
  const naming = update.title !== undefined && update.title !== conversation.title && namesNewChat(conversation, update, ownBefore);
  if (naming) scoped.title = update.title;
  else if (update.title !== undefined && update.title !== conversation.title) refused.push("title");
  if (update.repoPath !== undefined && (update.repoPath ?? undefined) !== conversation.repoPath) refused.push("repoPath");
  const metadata: Record<string, unknown> = { ...(update.metadata ?? {}) };
  const next: Record<string, unknown> = {};
  if (naming) next.autoTitle = metadata.autoTitle;
  for (const key of Object.keys(metadata)) {
    if (key === "participants" || key === "appToolApprovalPolicies" || (key === "autoTitle" && naming)) continue;
    if (JSON.stringify(metadata[key]) !== JSON.stringify(current[key])) refused.push(key);
  }
  // A key taken away is a list emptied: the rules a machine may drop (its own
  // members') go; anything else it takes away stays.
  const removed = new Set(update.removedMetadataKeys ?? []);
  for (const key of removed) if (key !== "appToolApprovalPolicies") refused.push(`-${key}`);
  if (removed.has("appToolApprovalPolicies") && metadata.appToolApprovalPolicies === undefined) metadata.appToolApprovalPolicies = [];

  // A lasting change comes from an approval or an `/accord` once: a later
  // write citing it again (an old copy, or a write around the app after the
  // User took the right back) does not count.
  const used = context.used ?? new Set<string>();
  const beforePolicies = policiesOf(current.appToolApprovalPolicies);
  const mainSessionId = mainSessionParticipantId(current);
  const changes: MemberChanges = {
    // As the server has it: a raise in this same write does not count.
    mainSession: mainSessionId ? beforeById.get(mainSessionId) : undefined,
    machineMembers: ownBefore, policies: beforePolicies, approved: latestPlanAnswersOnly(approvedRequests(context.approvals, used), context.approvals), rules: context.rules,
    claimed: new Set(), noted: new Set()
  };
  let members = before;
  if (metadata.participants !== undefined) {
    const proposed = participantsOf(metadata.participants);
    const proposedIds = new Set(proposed.map((participant) => participant.id));
    const taken: ChatParticipant[] = [];
    members = proposed.flatMap((participant) => {
      const existing = beforeById.get(participant.id);
      if (!existing) {
        // A name another member has would speak for that one.
        const clash = [...beforeById.values(), ...taken].some((other) => other.id !== participant.id && handleKey(other.handle) === handleKey(participant.handle));
        const allowed = clash ? undefined : additionAllowed(participant, changes);
        if (allowed) {
          // A member a machine adds brings no session with it, nor a copy
          // of another chat's member: only the computer hands a member its
          // session, when it moves it or forks a member to a new chat.
          const stripped = withoutComputerOnlyFields(participant);
          let added = stripped.member;
          for (const field of stripped.removed) refused.push(`participants.${participant.id}.${field}`);
          // One added without a card in a chat with a main session says who
          // added it, so every device holds it to the main session's rights
          // at each turn (docs/main-session.md).
          if (allowed !== "card" && changes.mainSession && added.delegatedByParticipantId !== allowed.id) {
            added = withDelegator(added, allowed.id);
            refused.push(`participants.${participant.id}.delegatedBy`);
          }
          // One the User approved on a card is hers: not marked, whatever
          // the machine wrote (as the app marks only additions without one).
          if (allowed === "card" && added.delegatedByParticipantId !== undefined) {
            added = withDelegator(added, undefined);
            refused.push(`participants.${participant.id}.delegatedBy`);
          }
          taken.push(added);
          return [added];
        }
        refused.push(`participants.${participant.id}.added`);
        return [];
      }
      if (runsOnMachine(existing, machineId)) {
        const kept = keepRequestRight(keepRole(keepHome(keepRights(participant, existing, changes.approved, changes.noted), existing), existing), existing,
          () => leaveGiven(conversation, existing, changes.approved, used, changes.rules), changes.noted);
        if (JSON.stringify(kept) !== JSON.stringify(participant)) refused.push(`participants.${participant.id}.rights`);
        return [kept];
      }
      const kept = keepElsewhere(conversation, participant, existing, used, changes.noted, changes.rules);
      if (JSON.stringify(kept) !== JSON.stringify(participant)) refused.push(`participants.${participant.id}`);
      return [kept];
    });
    // A member left out (taken out, or missing from an old copy) goes only
    // as the app takes one out; otherwise it stays.
    for (const participant of before) {
      if (proposedIds.has(participant.id) || removalAllowed(participant, changes, current.mainSessionParticipantId)) continue;
      refused.push(`participants.${participant.id}.removed`);
      members.push(participant);
    }
    // The last member stays, as in the app.
    if (!members.length && before.length) {
      refused.push("participants.last");
      members = before;
    }
    next.participants = members;
  }

  if (metadata.appToolApprovalPolicies !== undefined || metadata.participants !== undefined) {
    const present = new Set(members.map((participant) => participant.id));
    const own = (policy: ChatAppToolApprovalPolicy) => runsOnMachine(members.find((participant) => participant.id === policy.participantId), machineId);
    // A rule goes with a member removed (the app removes the rules it owns
    // and those aimed at it).
    const stays = (policy: ChatAppToolApprovalPolicy) => present.has(policy.participantId) && (!policy.targetParticipantId || present.has(policy.targetParticipantId));
    // A rule is the User's "Allow for this chat" on one of the member's
    // requests, as the app keeps it: one the machine adds without it, or
    // shaped otherwise, does not count. (The same answer that added members
    // in this write keeps the rule it gives.)
    const answered = (policy: ChatAppToolApprovalPolicy) => {
      if (beforePolicies.some((item) => item.id === policy.id && JSON.stringify(item) === JSON.stringify(policy))) return true;
      const answer = changes.approved.find((item) => isPolicyFor(policy, item));
      if (answer) changes.noted.add(answer.key);
      return Boolean(answer);
    };
    if (metadata.appToolApprovalPolicies !== undefined) {
      const proposed = policiesOf(metadata.appToolApprovalPolicies);
      const kept = [
        ...proposed.filter((policy) => own(policy) && stays(policy) && answered(policy)),
        ...beforePolicies.filter((policy) => !own(policy) && stays(policy))
      ];
      for (const policy of proposed) {
        if (!kept.includes(policy) && !beforePolicies.some((item) => item.id === policy.id && JSON.stringify(item) === JSON.stringify(policy))) refused.push(`appToolApprovalPolicies.${policy.id}`);
      }
      next.appToolApprovalPolicies = kept;
    } else {
      // Members removed without the rules in the same write: their rules go
      // anyway, so a member added again later does not find them waiting.
      const pruned = beforePolicies.filter(stays);
      if (pruned.length !== beforePolicies.length) next.appToolApprovalPolicies = pruned;
    }
  }

  if (Object.keys(next).length) scoped.metadata = next;
  return { update: scoped, refused, used: [...changes.noted] };
}
