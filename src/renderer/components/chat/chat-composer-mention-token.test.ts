import assert from "node:assert/strict";
import test from "node:test";

import { draftHasMention, draftMentionRanges } from "./chat-composer-mention-token";

test("composer mentions use timeline-compatible punctuation boundaries", () => {
  assert.deepEqual(
    draftMentionRanges("Hi @alice, ask (@unknown) next.").map(({ handle }) => handle),
    ["alice", "unknown"]
  );
});

test("composer mentions do not highlight email local-parts", () => {
  assert.equal(draftHasMention("user@example.com"), false);
});
