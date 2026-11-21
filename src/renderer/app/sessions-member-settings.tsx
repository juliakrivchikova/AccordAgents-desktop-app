import type { ChatParticipant, ReviewProgress } from "../../shared/types";
import { mainSessionParticipantId } from "../../shared/mainSession";
import { memberSessionMoves } from "../../shared/memberSessionMove";
import { restartingMembers } from "../../shared/memberRestart";
import { ChatMemberActionsMenu, ChatMemberComposerSettings, memberSettingsActions } from "../components/chat/chat-member-model-access";
import type { MainSessionActions } from "../components/chat/chat-view-switch";
import type { useAppViewModel } from "./use-app-view-model";
import type { ChatActions } from "./use-chat-actions";

/**
 * The sessions view's settings of one member (the User, 2026-11-21): its
 * model, effort, permission mode and place as quiet controls under its
 * composer (the main session's under the main composer, a member's under its
 * session's composer); its … actions (Restart, Fork to new chat, Remove from
 * chat) in its session's header, the main session's in the chat title's menu.
 */
export function sessionsMemberSettings(input: {
  view: ReturnType<typeof useAppViewModel>;
  progressLog: readonly ReviewProgress[];
  chatActions: Pick<ChatActions, "updateChatParticipantRuntime" | "restartChatParticipant" | "removeChatParticipant">;
  forkToNewChat: (participantId: string) => unknown;
  forkToNewChatReason: (participant: ChatParticipant) => string | undefined;
}): {
  controls: (memberId: string) => JSX.Element | null;
  actions: (memberId: string) => JSX.Element | null;
  mainSessionActions: MainSessionActions;
} {
  const { view, chatActions } = input;
  const conversation = view.activeChatConversation;
  const mainId = conversation ? mainSessionParticipantId(conversation.metadata) : undefined;
  const memberOf = (memberId: string): ChatParticipant | undefined => view.activeChatParticipants.find((candidate) => candidate.id === memberId);
  const actionProps = (memberId: string, participant: ChatParticipant) => ({
    status: view.participantStatusById.get(memberId),
    onRestart: (participantId: string, stopBackgroundTasks: boolean) => chatActions.restartChatParticipant(participantId, stopBackgroundTasks),
    onStopRestart: (runId: string) => void window.consensus.cancelReview(runId),
    restartStatus: restartingMembers(input.progressLog).get(memberId),
    onRemove: mainId === memberId ? undefined : () => void chatActions.removeChatParticipant(memberId),
    removeDisabledReason: view.busyParticipantIds.has(memberId) ? "busy" : undefined,
    onForkToNewChat: () => void input.forkToNewChat(memberId),
    forkToNewChatDisabledReason: input.forkToNewChatReason(participant)
  });
  return {
    controls: (memberId) => {
      const participant = memberOf(memberId);
      if (!conversation || !participant) return null;
      const status = view.participantStatusById.get(memberId);
      const hasRun = view.participantHasRunById.get(memberId) === true;
      return (
        <ChatMemberComposerSettings
          participant={participant}
          working={status === "running" || status === "compacting"}
          runLocationLocked={hasRun && !memberSessionMoves(participant)}
          runLocationMoves={hasRun && memberSessionMoves(participant)}
          mainSession={mainId && mainId !== memberId ? memberOf(mainId) : undefined}
          onUpdate={(participantId, patch) => chatActions.updateChatParticipantRuntime(participantId, patch)}
        />
      );
    },
    actions: (memberId) => {
      const participant = memberOf(memberId);
      if (!conversation || !participant) return null;
      return <ChatMemberActionsMenu participant={participant} {...actionProps(memberId, participant)} />;
    },
    mainSessionActions: (memberId, close, backgroundTaskCount) => {
      const participant = memberOf(memberId);
      if (!conversation || !participant) return [];
      return memberSettingsActions({ participant, backgroundTaskCount, close, ...actionProps(memberId, participant) });
    }
  };
}
