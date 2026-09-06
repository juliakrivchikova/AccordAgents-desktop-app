import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type { AvatarStudioTurnRequest, AvatarStudioTurnResult, SaveCustomAvatarRequest } from "../../../shared/avatarStudio";
import type { AgentHealth, AppSettings } from "../../../shared/types";
import { avatarStudioNeedsSeed, customAvatarId } from "../../../shared/avatarStudio";
import { reasoningEffortOptionsForProvider } from "../../../shared/reasoningEffort";
import { isChatAvatarIdForKind, mapChatAvatarIdToKind, normalizedChatAvatarId } from "../chat/chat-avatars";
import type { ChatParticipantDraft } from "../chat/chat-participant-drafts";
import { defaultChatParticipantDraft, updateChatParticipantDraft } from "../chat/chat-participant-drafts";
import { DEFAULT_SETTINGS } from "../../app/constants";
import { AvatarStudioDialog } from "./avatar-studio-dialog";

declare global {
  var ACCORD_RENDERER_JSDOM: boolean | undefined;
}

const SVG_DATA_URL = "data:image/svg+xml;base64,PHN2Zy8+";

let mounted: ReturnType<typeof createRoot> | undefined;

const AGENTS: AgentHealth[] = [
  { kind: "codex-cli", label: "Codex CLI", installed: true },
  { kind: "claude-code", label: "Claude Code", installed: true }
];

const SETTINGS: AppSettings = {
  ...DEFAULT_SETTINGS,
  providers: [
    { kind: "codex-cli", label: "Codex CLI", enabled: true },
    { kind: "claude-code", label: "Claude Code", enabled: true },
    { kind: "gemini-cli", label: "Antigravity", enabled: true }
  ]
};

interface Harness {
  turns: AvatarStudioTurnRequest[];
  saved: SaveCustomAvatarRequest[];
  closed: string[];
  used: string[];
  text(): string;
  find(testId: string): HTMLElement;
  type(value: string): Promise<void>;
  click(element: Element | null | undefined): Promise<void>;
  button(label: string): HTMLButtonElement;
}

async function mount(
  result: (request: AvatarStudioTurnRequest) => AvatarStudioTurnResult,
  agents: AgentHealth[] = AGENTS
): Promise<Harness> {
  assert.equal(globalThis.ACCORD_RENDERER_JSDOM, true, "run this test with scripts/renderer-jsdom-setup.mjs");
  // Unmount the previous studio: a root left behind would fire its own cleanup
  // against this test's stubs and make the assertions read another window.
  if (mounted) {
    const previous = mounted;
    mounted = undefined;
    await act(async () => {
      previous.unmount();
    });
  }

  const turns: AvatarStudioTurnRequest[] = [];
  const saved: SaveCustomAvatarRequest[] = [];
  const closed: string[] = [];
  const used: string[] = [];
  (window as unknown as { consensus: unknown }).consensus = {
    listProviderModels: async () => ({ kind: "codex-cli", models: [], authoritative: false, fetchedAt: "" }),
    runAvatarStudioTurn: async (request: AvatarStudioTurnRequest) => {
      turns.push(request);
      return result(request);
    },
    cancelAvatarStudioTurn: async () => {},
    closeAvatarStudio: async (studioId: string) => {
      closed.push(studioId);
    },
    saveCustomAvatar: async (request: SaveCustomAvatarRequest) => {
      saved.push(request);
      return {
        ...SETTINGS,
        chatCustomAvatars: [{ id: "saved-1", mediaType: request.mediaType, label: request.label, createdAt: "now" }]
      };
    },
    readCustomAvatar: async () => {
      throw new Error("not used");
    }
  };
  document.body.replaceChildren();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted = root;
  await act(async () => {
    root.render(
      <AvatarStudioDialog
        open
        member={{ handle: "gera", roleLabel: "Software Engineer", kind: "claude-code" }}
        settings={SETTINGS}
        agents={agents}
        onOpenChange={() => {}}
        onUseAvatar={(avatarId) => used.push(avatarId)}
      />
    );
  });

  const find = (testId: string): HTMLElement => {
    const element = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    assert.ok(element, `missing ${testId}`);
    return element;
  };
  const click = async (element: Element | null | undefined): Promise<void> => {
    assert.ok(element, "missing element to click");
    await act(async () => {
      (element as HTMLElement).click();
    });
    // Let the handler's own awaits settle before the test asserts.
    await act(async () => {});
  };
  const button = (label: string): HTMLButtonElement => {
    const match = [...document.querySelectorAll("button")].find((node) => (node.textContent ?? "").includes(label));
    assert.ok(match, `missing button ${label}`);
    return match as HTMLButtonElement;
  };
  const type = async (value: string): Promise<void> => {
    const textarea = find("avatar-studio-prompt") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(textarea, value);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  return {
    turns,
    saved,
    closed,
    used,
    text: () => document.body.textContent ?? "",
    find,
    type,
    click,
    button
  };
}

function drawn(id: string): AvatarStudioTurnResult {
  return {
    ok: true,
    reply: "Готово.",
    candidate: {
      id,
      mediaType: "image/svg+xml",
      dataUrl: SVG_DATA_URL,
      drawnBy: { kind: "claude-code" },
      createdAt: "now"
    }
  };
}

async function ask(harness: Harness, prompt: string): Promise<void> {
  await harness.type(prompt);
  await harness.click(harness.button("Send"));
}

test("the studio opens empty and runs nothing until the user asks", async () => {
  const harness = await mount(() => drawn("c1"));
  assert.match(harness.find("avatar-studio-canvas").textContent ?? "", /The avatar appears here/);
  assert.equal(harness.turns.length, 0);
  assert.equal((harness.find("avatar-studio-use") as HTMLButtonElement).disabled, true);
});

test("the first message is the prompt and carries the member's identity", async () => {
  const harness = await mount(() => drawn("c1"));
  await ask(harness, "нарисуй лису");
  assert.equal(harness.turns.length, 1);
  assert.equal(harness.turns[0].prompt, "нарисуй лису");
  assert.deepEqual(harness.turns[0].member, { handle: "gera", roleLabel: "Software Engineer" });
  assert.equal(harness.turns[0].baseCandidate, undefined);
  assert.equal(harness.turns[0].runner.kind, "claude-code");
  assert.equal(harness.find("avatar-studio-canvas").querySelector("img")?.getAttribute("src"), SVG_DATA_URL);
});

test("a refinement on the same runner does not re-send the picture", async () => {
  let drawnCount = 0;
  const harness = await mount(() => drawn(`c${(drawnCount += 1)}`));
  await ask(harness, "нарисуй лису");
  await ask(harness, "теплее фон");
  assert.equal(harness.turns.length, 2);
  // The session that drew it already has it; sending it again is megabytes for nothing.
  assert.equal(harness.turns[1].baseCandidate, undefined);
});

test("the picture travels only when the target session cannot know it", () => {
  const drewWith = { drawnBy: { kind: "claude-code" as const, model: "opus" } };
  // Same runner: the session that drew it already has it.
  assert.equal(avatarStudioNeedsSeed(drewWith, { kind: "claude-code", model: "opus" }), false);
  // Another provider, or another model/effort, starts a fresh session.
  assert.equal(avatarStudioNeedsSeed(drewWith, { kind: "codex-cli", model: "opus" }), true);
  assert.equal(avatarStudioNeedsSeed(drewWith, { kind: "claude-code", model: "sonnet" }), true);
  assert.equal(avatarStudioNeedsSeed(drewWith, { kind: "claude-code", model: "opus", reasoningEffort: "high" }), true);
  // Nothing on screen yet: nothing to seed.
  assert.equal(avatarStudioNeedsSeed(undefined, { kind: "claude-code" }), false);
});

test("using an avatar saves the picture once and hands the id back to the form", async () => {
  const harness = await mount(() => drawn("c1"));
  await ask(harness, "нарисуй лису");
  const use = harness.find("avatar-studio-use") as HTMLButtonElement;
  assert.equal(use.disabled, false);
  await harness.click(use);
  assert.equal(harness.saved.length, 1);
  assert.equal(harness.saved[0].mediaType, "image/svg+xml");
  assert.equal(harness.saved[0].dataBase64, "PHN2Zy8+");
  assert.deepEqual(harness.used, ["custom:saved-1"]);
  // Leaving the studio ends its drawing sessions (closing is idempotent).
  assert.ok(harness.closed.length >= 1, `expected a close, got ${JSON.stringify(harness.closed)}`);
  assert.ok(harness.closed.every((id) => id === harness.closed[0]), `closed ids: ${JSON.stringify(harness.closed)}`);
});

test("a failed turn shows the reason and leaves the member's avatar alone", async () => {
  const harness = await mount(() => ({ ok: false, error: "claude: not logged in" }));
  await ask(harness, "нарисуй лису");
  assert.match(harness.find("avatar-studio-messages").textContent ?? "", /not logged in/);
  assert.equal((harness.find("avatar-studio-use") as HTMLButtonElement).disabled, true);
  assert.deepEqual(harness.used, []);
});

test("Antigravity is not offered as a drawing provider", async () => {
  const harness = await mount(() => drawn("c1"));
  assert.match(harness.text(), /Claude Code/);
  assert.doesNotMatch(harness.text(), /Antigravity/);
});

test("with no drawing CLI ready the studio says so instead of offering to draw", async () => {
  const harness = await mount(() => drawn("c1"), []);
  assert.match(harness.text(), /Connect Codex CLI or Claude Code/);
  assert.equal((harness.find("avatar-studio-prompt") as HTMLTextAreaElement).disabled, true);
  await harness.type("нарисуй лису");
  assert.equal(harness.turns.length, 0);
});

test("a drawn avatar survives draft normalisation and a provider change", () => {
  const drawn = customAvatarId("saved-1");
  // Presets are provider-specific; a drawn avatar is the member's own picture.
  assert.equal(isChatAvatarIdForKind(drawn, "codex-cli"), true);
  assert.equal(isChatAvatarIdForKind(drawn, "claude-code"), true);
  assert.equal(normalizedChatAvatarId("claude-code", drawn, "gera"), drawn);
  assert.equal(mapChatAvatarIdToKind("codex-cli", drawn, "gera"), drawn);
  const base: ChatParticipantDraft = { ...defaultChatParticipantDraft(SETTINGS), handle: "gera", kind: "claude-code" };
  const withDrawn = updateChatParticipantDraft(base, SETTINGS, { avatarId: drawn });
  assert.equal(withDrawn.avatarId, drawn);
  const switched = updateChatParticipantDraft(withDrawn, SETTINGS, { kind: "codex-cli" });
  assert.equal(switched.avatarId, drawn, "a provider change must not replace the drawn avatar");
});

test("the studio offers the provider's own reasoning levels, not a shorter list", async () => {
  const harness = await mount(() => drawn("c1"));
  const levels = async (): Promise<string[]> => {
    if (!document.querySelector(".chat-app-tool-inline-menu")) {
      await harness.click(document.querySelector('[aria-label="Change reasoning"]'));
      await act(async () => {});
    }
    const offered = [...document.querySelectorAll(".chat-app-tool-inline-menu button")].map((node) => (node.textContent ?? "").trim());
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    return offered;
  };
  const expected = (kind: "claude-code" | "codex-cli"): string[] =>
    ["CLI default", ...reasoningEffortOptionsForProvider(kind).map((option) => option.label)];

  // The member is on Claude, so its own levels are offered.
  assert.deepEqual(await levels(), expected("claude-code"));

  await harness.click(document.querySelector('[aria-label="Change drawn by"]'));
  await act(async () => {});
  const codex = [...document.querySelectorAll("button")].find((node) => (node.textContent ?? "").trim() === "Codex CLI" && node.closest(".chat-app-tool-inline-menu"));
  assert.ok(codex, `provider options: ${JSON.stringify([...document.querySelectorAll(".chat-app-tool-inline-menu button")].map((n) => n.textContent?.trim()))}`);
  await harness.click(codex);
  await act(async () => {});
  // Codex reaches further: Minimal at one end, Ultra at the other.
  assert.deepEqual(await levels(), expected("codex-cli"));
});
