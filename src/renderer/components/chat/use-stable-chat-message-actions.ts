import { useCallback, useMemo, useRef } from "react";

type ChoiceSubmittingRunner = (id: string, task: () => Promise<void>) => Promise<void>;

export type StableChatChoiceResponse = {
  cancel?: boolean;
  selectedOptionId?: string;
  customAnswer?: string;
  note?: string;
};

export type StableParticipantCompactContext = {
  threadId?: string;
  parentMessageId?: string;
  chatThreadRootId?: string;
};

export type StableChatMessageActions = {
  onApproveMentions: (sourceMessageId: string, targetParticipantIds: string[], continueRequester: boolean) => void;
  onRejectMentions: (sourceMessageId: string, targetParticipantIds: string[]) => void;
  onRespondToChoice: (sourceMessageId: string, choiceId: string, response: StableChatChoiceResponse) => void | Promise<void>;
  onToggleReaction: (messageId: string, emoji: string) => void;
  onCompactParticipant: (participantId: string, context?: StableParticipantCompactContext) => void | Promise<boolean>;
  onStopRun: (runId: string) => void;
};

export type StableChatMessageActionHandlers = Omit<StableChatMessageActions, "onStopRun"> & {
  runChoiceWithSubmittingId: ChoiceSubmittingRunner;
  onStopRun?: (runId: string) => void;
};

export function useStableChatMessageActions(
  handlers: StableChatMessageActionHandlers
): StableChatMessageActions {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const onApproveMentions = useCallback<StableChatMessageActions["onApproveMentions"]>(
    (sourceMessageId, targetParticipantIds, continueRequester) => {
      handlersRef.current.onApproveMentions(sourceMessageId, targetParticipantIds, continueRequester);
    },
    []
  );

  const onRejectMentions = useCallback<StableChatMessageActions["onRejectMentions"]>(
    (sourceMessageId, targetParticipantIds) => {
      handlersRef.current.onRejectMentions(sourceMessageId, targetParticipantIds);
    },
    []
  );

  const onRespondToChoice = useCallback<StableChatMessageActions["onRespondToChoice"]>(
    async (sourceMessageId, choiceId, response) => {
      await handlersRef.current.runChoiceWithSubmittingId(choiceId, async () => {
        await handlersRef.current.onRespondToChoice(sourceMessageId, choiceId, response);
      });
    },
    []
  );

  const onToggleReaction = useCallback<StableChatMessageActions["onToggleReaction"]>(
    (messageId, emoji) => {
      handlersRef.current.onToggleReaction(messageId, emoji);
    },
    []
  );

  const onCompactParticipant = useCallback<StableChatMessageActions["onCompactParticipant"]>(
    (participantId, context) => handlersRef.current.onCompactParticipant(participantId, context),
    []
  );

  const onStopRun = useCallback<StableChatMessageActions["onStopRun"]>(
    (runId) => {
      handlersRef.current.onStopRun?.(runId);
    },
    []
  );

  return useMemo(() => ({
    onApproveMentions,
    onRejectMentions,
    onRespondToChoice,
    onToggleReaction,
    onCompactParticipant,
    onStopRun
  }), [
    onApproveMentions,
    onCompactParticipant,
    onRejectMentions,
    onRespondToChoice,
    onStopRun,
    onToggleReaction
  ]);
}
