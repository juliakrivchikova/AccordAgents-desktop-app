import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { ReviewProgress } from "../../../shared/types";
import { markdownBlocks } from "../content/markdown-blocks";
import { chatThinkingRows, liveMessageProgressById } from "./chat-conversation-progress";
import {
  useStableChatMessageActions,
  type StableChatMessageActionHandlers,
  type StableChatMessageActions
} from "./use-stable-chat-message-actions";

const NOW = "2026-07-12T12:00:00.000Z";

test("chat progress helpers clear live rows on terminal phases", () => {
  const progress: ReviewProgress[] = [
    {
      runId: "run-1",
      phase: "debate",
      message: "Agent is responding.",
      createdAt: NOW,
      agentProgress: {
        participantId: "participant-1",
        participantLabel: "@agent",
        state: "running",
        activity: "Thinking"
      }
    },
    {
      runId: "run-2",
      phase: "debate",
      message: "Agent is streaming.",
      createdAt: NOW,
      agentProgress: {
        participantId: "participant-2",
        participantLabel: "@streamer",
        state: "running",
        messageId: "message-1",
        partialContent: "Partial"
      }
    },
    {
      runId: "run-1",
      phase: "cancelled",
      message: "Cancelled.",
      createdAt: NOW
    },
    {
      runId: "run-2",
      phase: "error",
      message: "Errored.",
      createdAt: NOW
    }
  ];

  assert.deepEqual(chatThinkingRows(progress), []);
  assert.deepEqual([...liveMessageProgressById(progress).keys()], []);
});

test("markdown block parsing preserves mixed streaming-style content", () => {
  const content = [
    "### Result",
    "",
    "- one",
    "- two",
    "",
    "Plain `inline` text."
  ].join("\n");
  const blocks = markdownBlocks(content);

  assert.deepEqual(blocks.map((block) => block.type), ["heading", "ul", "paragraph"]);
  assert.equal(blocks[0].type === "heading" ? blocks[0].text : "", "Result");
  assert.deepEqual(blocks[1].type === "ul" ? blocks[1].items : [], ["one", "two"]);
});

test("stable chat message actions keep row callback identities while calling latest handlers", async () => {
  const snapshots: StableChatMessageActions[] = [];
  const calls: string[] = [];

  function Probe(props: StableChatMessageActionHandlers): null {
    snapshots.push(useStableChatMessageActions(props));
    return null;
  }

  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<Probe {...stableActionHandlers("first", calls)} />);
  });
  const first = snapshots.at(-1);
  assert.ok(first);

  await act(async () => {
    renderer!.update(<Probe {...stableActionHandlers("second", calls)} />);
  });
  const second = snapshots.at(-1);
  assert.ok(second);

  assert.equal(second.onApproveMentions, first.onApproveMentions);
  assert.equal(second.onRejectMentions, first.onRejectMentions);
  assert.equal(second.onRespondToChoice, first.onRespondToChoice);
  assert.equal(second.onToggleReaction, first.onToggleReaction);
  assert.equal(second.onCompactParticipant, first.onCompactParticipant);
  assert.equal(second.onStopRun, first.onStopRun);

  second.onApproveMentions("message-1", ["participant-1"], true);
  second.onRejectMentions("message-2", ["participant-2"]);
  second.onToggleReaction("message-3", "+1");
  second.onCompactParticipant("participant-3", { threadId: "thread-1" });
  second.onStopRun("run-1");
  await second.onRespondToChoice("message-4", "choice-1", { cancel: true });

  assert.deepEqual(calls, [
    "second:approve:message-1:participant-1:true",
    "second:reject:message-2:participant-2",
    "second:reaction:message-3:+1",
    "second:compact:participant-3:thread-1",
    "second:stop:run-1",
    "second:choice-run:choice-1",
    "second:choice:message-4:choice-1:true"
  ]);

  renderer!.unmount();
});

function stableActionHandlers(label: string, calls: string[]): StableChatMessageActionHandlers {
  return {
    onApproveMentions: (sourceMessageId, targetParticipantIds, continueRequester) => {
      calls.push(`${label}:approve:${sourceMessageId}:${targetParticipantIds.join(",")}:${String(continueRequester)}`);
    },
    onRejectMentions: (sourceMessageId, targetParticipantIds) => {
      calls.push(`${label}:reject:${sourceMessageId}:${targetParticipantIds.join(",")}`);
    },
    onRespondToChoice: (sourceMessageId, choiceId, response) => {
      calls.push(`${label}:choice:${sourceMessageId}:${choiceId}:${String(response.cancel === true)}`);
    },
    onToggleReaction: (messageId, emoji) => {
      calls.push(`${label}:reaction:${messageId}:${emoji}`);
    },
    onCompactParticipant: (participantId, context) => {
      calls.push(`${label}:compact:${participantId}:${context?.threadId ?? ""}`);
    },
    onStopRun: (runId) => {
      calls.push(`${label}:stop:${runId}`);
    },
    runChoiceWithSubmittingId: async (id, task) => {
      calls.push(`${label}:choice-run:${id}`);
      await task();
    }
  };
}
