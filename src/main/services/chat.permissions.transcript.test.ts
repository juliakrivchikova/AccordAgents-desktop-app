import assert from "node:assert/strict";
import test from "node:test";
import { processingTranscriptFromContent, processingTranscriptWithTerminalMessage } from "./chat/turns/replyMessages";
import {
  chatActivityEventsForSegment, chatActivityGroupSummary, chatInlineTranscriptBlocks, chatInlineTranscriptParts,
  chatProcessingTranscriptPrefix, chatProcessingTranscriptView, chatProcessingTranscriptViewHasHidden
} from "../../shared/processingTranscript";
import { NOW, testService } from "./chat/test/permissionFixtures";

test("processing transcript metadata preserves visible stream text", () => {
  const service = testService().service as any;

  assert.deepEqual(processingTranscriptFromContent("partial reply\n", NOW), {
    content: "partial reply",
    capturedAt: NOW,
    originalLength: "partial reply".length
  });
  assert.equal(processingTranscriptFromContent("   ", NOW), undefined);
});

test("processing transcript metadata keeps 100k streams untruncated and bounds pathological streams", () => {
  const service = testService().service as any;
  const ordinary = `${"a".repeat(100_010)}tail`;
  const ordinaryTranscript = processingTranscriptFromContent(ordinary, NOW);
  const oversized = `${"a".repeat(2_000_005)}tail`;
  const oversizedTranscript = processingTranscriptFromContent(oversized, NOW);

  assert.equal(ordinaryTranscript!.content, ordinary);
  assert.equal(ordinaryTranscript!.originalLength, ordinary.length);
  assert.equal(ordinaryTranscript!.retainedStart, undefined);
  assert.equal(ordinaryTranscript!.truncated, undefined);
  assert.equal(oversizedTranscript!.content.length, 2_000_000);
  assert.equal(oversizedTranscript!.content.endsWith("tail"), true);
  assert.equal(oversizedTranscript!.originalLength, oversized.length);
  assert.equal(oversizedTranscript!.retainedStart, oversized.length - 2_000_000);
  assert.equal(oversizedTranscript!.truncated, true);
});

test("processing transcript metadata records omitted activity event count", () => {
  const service = testService().service as any;
  const transcript = processingTranscriptFromContent("partial reply", NOW, { omittedActivityEventCount: 3 });

  assert.equal(transcript!.omittedActivityEventCount, 3);
});

test("processing transcript stopped terminal note preserves and reapplies truncation metadata", () => {
  const service = testService().service as any;
  const terminal = "@codex stopped by user.";
  const appendedLength = `\n\n${terminal}`.length;
  const alreadyTruncated = processingTranscriptWithTerminalMessage({
    content: "a".repeat(2_000_000),
    capturedAt: NOW,
    originalLength: 2_000_010,
    retainedStart: 10,
    truncated: true
  }, terminal);
  const crossesLimit = processingTranscriptWithTerminalMessage({
    content: "b".repeat(2_000_000 - 3),
    capturedAt: NOW,
    originalLength: 2_000_000 - 3
  }, terminal);

  assert.equal(alreadyTruncated.content.length, 2_000_000);
  assert.equal(alreadyTruncated.content.endsWith(terminal), true);
  assert.equal(alreadyTruncated.originalLength, 2_000_010 + appendedLength);
  assert.equal(alreadyTruncated.retainedStart, 10 + appendedLength);
  assert.equal(alreadyTruncated.truncated, true);

  assert.equal(crossesLimit.content.length, 2_000_000);
  assert.equal(crossesLimit.content.endsWith(terminal), true);
  assert.equal(crossesLimit.originalLength, (2_000_000 - 3) + appendedLength);
  assert.equal(crossesLimit.retainedStart, appendedLength - 3);
  assert.equal(crossesLimit.truncated, true);
});

test("processing transcript expansion hides when transcript only contains the final answer", () => {
  const final = "Current EUR/RUB is about **89.8 RUB for 1 EUR**.";

  assert.equal(chatProcessingTranscriptPrefix(final, final), "");
  assert.equal(chatProcessingTranscriptPrefix(`\n${final}\n`, final), "");
});

test("processing transcript expansion returns only text before the final answer", () => {
  const final = "Final answer.";

  assert.equal(chatProcessingTranscriptPrefix(`Checking source...\n\n${final}`, final), "Checking source...");
});

test("processing transcript view keeps preamble hidden and final answer last", () => {
  const preamble = "I’ll check the existing settings first.\n\nSo far: settings are persisted through SettingsService.";
  const final = "Add a first-class `userProfile` setting.";
  const view = chatProcessingTranscriptView(`${preamble}\n\n${final}`, final);

  assert.deepEqual(view.leadingSegments.map((segment) => segment.content), [preamble]);
  assert.equal(view.finalSegment?.content, final);
  assert.equal(view.renderFinalContent, true);
});

test("processing transcript view keeps stored content verbatim for heuristic-looking final answers", () => {
  const content = "I'll check the box on Friday — that's my final recommendation, ship it.\n\nThe deploy window is clear.";
  const view = chatProcessingTranscriptView(content, content);

  assert.equal(view.leadingSegments.length, 0);
  assert.equal(view.finalSegment?.content, content);
  assert.equal(view.renderFinalContent, true);
});

test("processing transcript view does not collapse multi-step final answers to a fragment", () => {
  const content = "I'll create the schema first.\n\nThen I'll verify it.\n\nDone.";
  const view = chatProcessingTranscriptView(content, content);

  assert.equal(view.leadingSegments.length, 0);
  assert.equal(view.finalSegment?.content, content);
});

test("processing transcript view does not split markdown fences with paragraph heuristics", () => {
  const content = "I'll show the exact block:\n\n```ts\nconst value = 1;\n\nconst next = 2;\n```\n\nUse both values.";
  const view = chatProcessingTranscriptView(content, content);

  assert.equal(view.finalSegment?.content, content);
  assert.equal(view.leadingSegments.length, 0);
});

test("processing transcript view keeps all-processing-looking content intact", () => {
  const content = "Checking the release notes.\n\nOK";
  const view = chatProcessingTranscriptView(content, content);

  assert.equal(view.finalSegment?.content, content);
  assert.equal(view.renderFinalContent, true);
});

test("processing transcript activity events are interleaved before and inside the final answer", () => {
  const first = "I’ll check the available roles first so I don’t duplicate an existing medical-specialist role, then I’ll request the new role for app approval.";
  const second = "No existing specialist role matches this, so I’m creating a custom `Gastroenterologist` role with medical-safety boundaries and practical digestive-health guidance.";
  const final = "Requested a new `Gastroenterologist` role. It’s pending your approval in the app.";
  const content = [first, second, final].join("\n\n");
  const prefix = chatProcessingTranscriptPrefix(content, final);
  const view = chatProcessingTranscriptView(content, final);
  const events = [
    { id: "describe", sequence: 1, kind: "tool" as const, label: "Using app_roles_describe_options", createdAt: NOW, afterContentLength: first.length },
    { id: "request", sequence: 2, kind: "tool" as const, label: "Using app_roles_request_change", createdAt: NOW, afterContentLength: [first, second].join("\n\n").length },
    { id: "final", sequence: 3, kind: "tool" as const, label: "Using final_check", createdAt: NOW, afterContentLength: content.length - 12 }
  ];
  const prefixSegment = view.leadingSegments[0];
  const finalSegment = view.finalSegment!;

  const prefixEvents = chatActivityEventsForSegment(events, prefixSegment);
  const finalEvents = chatActivityEventsForSegment(events, finalSegment);
  const parts = chatInlineTranscriptParts(prefix, events, prefixSegment);

  assert.equal(prefix, [first, second].join("\n\n"));
  assert.equal(view.renderFinalContent, true);
  assert.deepEqual(prefixEvents.map((event) => event.id), ["describe", "request"]);
  assert.deepEqual(finalEvents.map((event) => event.id), ["final"]);
  assert.deepEqual(parts.map((part) => part.kind === "activity" ? part.event.id : part.text.trim()), [
    first,
    "describe",
    second,
    "request"
  ]);
});

test("inline transcript snaps activity rows to the next sentence boundary", () => {
  const firstSentence = "Current EUR/RUB is about 1 EUR = 89.88 RUB.";
  const content = `${firstSentence} Next sentence.`;
  const event = {
    id: "search",
    sequence: 1,
    kind: "web" as const,
    label: "Using web search",
    createdAt: NOW,
    afterContentLength: "Current EUR/RUB is".length
  };
  const parts = chatInlineTranscriptParts(content, [event]);

  assert.deepEqual(parts.map((part) => part.kind === "activity" ? `${part.event.id}:${part.event.afterContentLength}` : part.text), [
    firstSentence,
    `search:${firstSentence.length}`,
    " Next sentence."
  ]);
});

test("inline transcript blocks group consecutive activities and only text splits a group", () => {
  const first = "Reading the diff.";
  const second = "Checking the logs.";
  const content = `${first}\n\n${second}`;
  const event = (id: string, sequence: number, afterContentLength: number) => ({
    id,
    sequence,
    kind: "command" as const,
    label: "Using Bash",
    createdAt: NOW,
    afterContentLength
  });
  const blocks = chatInlineTranscriptBlocks(chatInlineTranscriptParts(content, [
    event("a", 1, first.length),
    event("b", 2, first.length + 1),
    event("c", 3, first.length + 2),
    event("d", 4, content.length),
    event("e", 5, content.length)
  ]));

  const describe = (items: ReturnType<typeof chatInlineTranscriptBlocks>) => items.map((block) => block.kind === "text"
    ? block.text.trim()
    : block.kind === "activity"
      ? `alone:${block.event.id}`
      : block.events.map((item) => item.id).join(","));
  assert.deepEqual(describe(blocks), [
    first,
    "a,b,c",
    second,
    "d,e"
  ]);

  const notices = chatInlineTranscriptBlocks(chatInlineTranscriptParts(content, [
    event("a", 1, first.length),
    { ...event("stall", 2, first.length), kind: "status" as const, label: "No provider output for 5 minutes" },
    event("b", 3, first.length),
    { ...event("review", 4, first.length), kind: "approval" as const, label: "Auto-reviewing approval request" },
    { ...event("refused", 5, first.length), kind: "approval" as const, status: "failed" as const, label: "Could not approve" },
    event("c", 6, first.length)
  ]));
  assert.deepEqual(describe(notices), [first, "a", "alone:stall", "b,review", "alone:refused", "c", second]);
  assert.deepEqual(chatInlineTranscriptBlocks([]), []);
  assert.equal(chatActivityGroupSummary(1), "1 command");
  assert.equal(chatActivityGroupSummary(12), "12 commands");
});

test("inline transcript anchors activity rows at segment end when no boundary follows", () => {
  const content = "Streaming without terminal boundary";
  const event = {
    id: "tool",
    sequence: 1,
    kind: "tool" as const,
    label: "Using tool",
    createdAt: NOW,
    afterContentLength: "Streaming".length
  };
  const parts = chatInlineTranscriptParts(content, [event]);

  assert.deepEqual(parts.map((part) => part.kind === "activity" ? `${part.event.id}:${part.event.afterContentLength}` : part.text), [
    content,
    `tool:${content.length}`
  ]);
});

test("inline transcript preserves sequence for multiple activities in one sentence", () => {
  const content = "Current EUR/RUB is about 1 EUR = 89.88 RUB.";
  const events = [
    { id: "search", sequence: 1, kind: "web" as const, label: "Using web search", createdAt: NOW, afterContentLength: "Current EUR/RUB is".length },
    { id: "read", sequence: 2, kind: "tool" as const, label: "Reading result", createdAt: NOW, afterContentLength: "Current EUR/RUB is about".length }
  ];
  const parts = chatInlineTranscriptParts(content, events);

  assert.deepEqual(parts.map((part) => part.kind === "activity" ? `${part.event.id}:${part.event.afterContentLength}` : part.text), [
    content,
    `search:${content.length}`,
    `read:${content.length}`
  ]);
});

test("inline transcript treats parenthetical citations as sentence boundaries", () => {
  const firstParagraph = "Current EUR/RUB is about 1 EUR = 89.88 RUB. (exchange-rates.org)";
  const secondParagraph = "For comparison, the Bank of Russia official rate is 87.4027 RUB per EUR. (cbr.ru)";
  const content = `${firstParagraph}\n\n${secondParagraph}`;
  const event = {
    id: "search",
    sequence: 1,
    kind: "web" as const,
    label: "Using web search",
    createdAt: NOW,
    afterContentLength: "Current EUR/RUB is".length
  };
  const parts = chatInlineTranscriptParts(content, [event]);

  assert.deepEqual(parts.map((part) => part.kind === "activity" ? `${part.event.id}:${part.event.afterContentLength}` : part.text), [
    firstParagraph,
    `search:${firstParagraph.length}`,
    `\n\n${secondParagraph}`
  ]);
});

test("processing transcript expansion exposes activity-only hidden material", () => {
  const final = "Final answer.";
  const view = chatProcessingTranscriptView(final, final);
  const events = [
    { id: "tool", sequence: 1, kind: "tool" as const, label: "Using web search", createdAt: NOW }
  ];

  assert.equal(chatProcessingTranscriptPrefix(final, final), "");
  assert.equal(chatProcessingTranscriptViewHasHidden(view, events), true);
  assert.deepEqual(chatActivityEventsForSegment(events, view.finalSegment!).map((event) => event.id), ["tool"]);
});

test("processing transcript expansion never duplicates a non-trailing final answer", () => {
  const final = "Final answer.";
  const transcript = `Setup.\n\n${final}\n\nFollow-up tool output.`;
  const view = chatProcessingTranscriptView(transcript, final);

  assert.equal(view.renderFinalContent, false);
  assert.equal(view.leadingSegments[0].content, transcript);
  assert.equal(chatProcessingTranscriptPrefix(transcript, final), "");
});

test("processing transcript boundary activity belongs to the final segment only", () => {
  const prefix = "I will use a tool.";
  const final = "Final answer.";
  const transcript = `${prefix}\n\n${final}`;
  const view = chatProcessingTranscriptView(transcript, final);
  const event = {
    id: "tool",
    sequence: 1,
    kind: "tool" as const,
    label: "Using final_check",
    createdAt: NOW,
    afterContentLength: prefix.length + 2
  };

  assert.deepEqual(chatActivityEventsForSegment([event], view.leadingSegments[0]).map((item) => item.id), []);
  assert.deepEqual(chatActivityEventsForSegment([event], view.finalSegment!).map((item) => item.id), ["tool"]);
  assert.deepEqual(chatInlineTranscriptParts(final, [event], view.finalSegment!).map((part) => part.kind === "activity" ? part.event.id : part.text), [
    "tool",
    final
  ]);
});

test("processing transcript view surfaces truncation and rebases retained offsets", () => {
  const view = chatProcessingTranscriptView("retained text", "retained text", {
    retainedStart: 50,
    truncated: true,
    omittedActivityEventCount: 2
  });
  const events = [
    { id: "old", sequence: 1, kind: "tool" as const, label: "Old", createdAt: NOW, afterContentLength: 10 },
    { id: "kept", sequence: 2, kind: "tool" as const, label: "Kept", createdAt: NOW, afterContentLength: 58 }
  ];

  assert.deepEqual(view.notices, ["Earlier stream output omitted.", "2 earlier activities omitted."]);
  assert.deepEqual(chatActivityEventsForSegment(events, view.finalSegment!).map((event) => `${event.id}:${event.afterContentLength}`), ["kept:8"]);
});
