import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_DEFAULT,
  CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_DEFAULT
} from "../../shared/chatParticipantRequests";
import { CHAT_AUTO_WATCH_WAKE_LIMIT_DEFAULT } from "../../shared/chatAutoWatch";
import { DEFAULT_CHAT_PROMPT_CONTEXT } from "../../shared/chatPromptContext";
import { ChatService } from "./chat";
import type { AppSettings, ChatParticipant, ChatRoleConfig } from "../../shared/types";

function role(over: Partial<ChatRoleConfig> & { id: string }): ChatRoleConfig {
  return {
    label: "Role",
    instructions: "Do the thing.",
    version: 1,
    builtIn: false,
    updatedAt: "2026-06-20T00:00:00.000Z",
    ...over
  };
}

// Build a ChatService without its constructor; only role resolution is exercised,
// which depends solely on this.settings.getPublicSettings plus prototype helpers.
function chatServiceWithRoles(roles: ChatRoleConfig[]) {
  const service = Object.create(ChatService.prototype) as any;
  service.settings = {
    async getPublicSettings(): Promise<AppSettings> {
      return {
        roundLimitDefault: 1,
        cliAgentRunTimeoutMs: 1,
        chatAutoWatchWakeLimit: CHAT_AUTO_WATCH_WAKE_LIMIT_DEFAULT,
        chatParticipantRequestMaxDepth: CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_DEFAULT,
        chatParticipantRequestPromptMaxChars: CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_DEFAULT,
        chatPromptContext: DEFAULT_CHAT_PROMPT_CONTEXT,
        cloudRuns: {
          enabled: false,
          mode: "ssh",
          worker: {},
          hasAwsCredentials: false,
          awsInstanceType: "t3.small",
          awsRootVolumeSizeGb: 8,
          maxRuntimeMs: 24 * 60 * 60_000,
          pollIntervalMs: 2_500
        },
        providers: [],
        chatRoleConfigs: roles,
        chatBehaviorRules: [],
        chatSavedPrompts: [],
        chatParticipantConfigs: [],
        chatParticipantSeedState: {}
      };
    }
  };
  return service;
}

function participant(roleConfigId: string): ChatParticipant {
  return { id: "p", handle: "h", roleConfigId, kind: "codex-cli" };
}

const GENERIC = role({
  id: "generic-participant",
  label: "Generic Participant",
  instructions: "Be generic.",
  builtIn: true
});

test("a missing role falls back to generic-participant instead of throwing", async () => {
  const service = chatServiceWithRoles([GENERIC]);
  const resolved = await service.resolvedRoleForParticipantOrThrow(participant("deleted-role"));
  assert.equal(resolved.id, "generic-participant");
});

test("an archived role still resolves to its own instructions", async () => {
  const service = chatServiceWithRoles([
    GENERIC,
    role({ id: "custom-reviewer", label: "Reviewer", instructions: "Review carefully.", archivedAt: "2026-06-20T00:00:00.000Z" })
  ]);
  const resolved = await service.resolvedRoleForParticipantOrThrow(participant("custom-reviewer"));
  assert.equal(resolved.id, "custom-reviewer");
  assert.match(resolved.instructions, /Review carefully/);
});

test("throws when the role and the generic fallback are both absent", async () => {
  const service = chatServiceWithRoles([role({ id: "only-this", label: "Only" })]);
  await assert.rejects(() => service.resolvedRoleForParticipantOrThrow(participant("missing")), /Unknown role/);
});
