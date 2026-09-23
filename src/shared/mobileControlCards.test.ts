import assert from "node:assert/strict";
import test from "node:test";
import { controlCardFromChoiceMessage } from "./mobileControlCards";
import type { ChatMessage } from "./types";

function choiceMessage(recommendedOptionId?: string): ChatMessage {
  return {
    id: "message-1",
    role: "participant",
    participantLabel: "@taylor",
    content: "Which one?",
    createdAt: "2026-09-22T19:00:00.000Z",
    metadata: {
      pendingChoice: {
        id: "choice-1",
        title: "Artifacts in search",
        question: "Should search also match text inside artifacts?",
        options: [
          { id: "both", label: "Searchable and readable", description: "Search finds text inside artifacts." },
          { id: "read", label: "Readable only", description: "Agents open artifacts they already found." }
        ],
        ...(recommendedOptionId ? { recommendedOptionId } : {}),
        status: "pending"
      }
    }
  } as unknown as ChatMessage;
}

// The phone showed a member's choice without its recommendation (the User,
// 2026-09-22): the card it is sent never carried one.
test("a choice card carries the member's recommendation and each option's description", () => {
  const card = controlCardFromChoiceMessage("conversation-1", choiceMessage("both"));
  assert.equal(card?.recommendedOptionId, "both");
  assert.deepEqual(card?.options.map((option) => option.description), [
    "Search finds text inside artifacts.",
    "Agents open artifacts they already found."
  ]);
});

test("a recommendation that names no option of the choice is left off", () => {
  assert.equal(controlCardFromChoiceMessage("conversation-1", choiceMessage("gone"))?.recommendedOptionId, undefined);
  assert.equal(controlCardFromChoiceMessage("conversation-1", choiceMessage())?.recommendedOptionId, undefined);
});
