import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const participantTermPattern = /\b[Pp]articipants?\b/;

const rendererRoots = ["src/renderer"];
const mainUserFacingFiles = [
  "src/main/services/chat.ts",
  "src/main/services/settings.ts",
  "src/main/services/userSkills.ts"
];
const exactCheckFiles = [
  ...mainUserFacingFiles,
  "src/main/appSkills/accord/SKILL.md",
  "src/main/appSkills/app-chat-reply/SKILL.md",
  "src/main/appSkills/app-chat-request/SKILL.md"
];

const staleProductSnippets = [
  "Add at least two participants",
  "participants are running",
  "Pick the facilitator, the participants",
  "selected participants",
  "Choose at least one participant",
  "Add participants",
  "New participant",
  "No saved participants",
  "saved participant",
  "participant preset",
  "Participant avatar",
  "Participant role",
  "Participant model",
  "Participant reasoning",
  "Request participants",
  "Mention participants",
  "running participants",
  "mentioned participants",
  "participant mention",
  "participant context",
  "Mention a participant",
  "Participant added",
  "Participants added",
  "requested participants",
  "Codex participants",
  "Add another participant",
  "Chat participant was not found",
  "Run location is locked after the participant",
  "Only one participant can watch",
  "Participants cannot be removed",
  "last chat participant",
  "accord facilitator or participant",
  "accord participant",
  "selected accord participants",
  "Plan mode blocks file edits for this participant",
  "Plan mode blocks shell commands for this participant",
  "Plan mode blocks provider-native tool grants for this participant",
  "Plan mode blocks GitHub App permission grants for this participant",
  "Switch the participant",
  "Claude Code participants",
  "Generic Participant",
  "roles and participants in this chat",
  "role and participant setup requests",
  "role and participant changes",
  "suitable participant who can help",
  "another participant unless User explicitly asks",
  "suitable participant is available",
  "roles and participants when User asks",
  "roles or participants were changed",
  "role or participant setup",
  "software development participants",
  "final synthesis participants",
  "role or participant request",
  "Participant names may",
  "Select a role for the participant",
  "assigned to a participant",
  "Duplicate participant name",
  "Chat supports local CLI participants only",
  "Chat MVP supports local CLI participants only",
  "single participant",
  "Mention exactly one participant",
  "Mention a participant before selecting a skill",
  "Unknown participant preset",
  "cannot be used for a new participant",
  "I can help set up roles and participants for this chat",
  "Ask another AccordAgents chat participant for a concrete answer",
  "Reply to a participant request that was addressed to your handle",
  "Facilitate a skeptical multi-participant AccordAgents discussion"
];

const internalLineSnippets = [
  "ChatParticipant",
  "ParticipantConfig",
  "ParticipantRunResult",
  "ParticipantCompact",
  "ParticipantRequest",
  "ParticipantChange",
  "ParticipantOperation",
  "ParticipantDraft",
  "ParticipantRole",
  "ParticipantRuntime",
  "ParticipantRoster",
  "ParticipantMention",
  "ParticipantLabel",
  "participantId",
  "participantIds",
  "participantLabel",
  "participantLabels",
  "participantKind",
  "participantConfig",
  "participantRequest",
  "participantRequests",
  "participantSessions",
  "participantCompactions",
  "participantRun",
  "participantHandle",
  "participantRole",
  "participantProvider",
  "participantOptions",
  "participantCount",
  "participantIndex",
  "participantStatus",
  "participantState",
  "participantName",
  "participantAvatar",
  "participantProfile",
  "participant.",
  "participants.",
  "participant)",
  "participant ?",
  "new-participant",
  "props.participant",
  "props.participants",
  "group.participants",
  "operation.participant",
  "participantFor",
  "participants.map",
  "participants.filter",
  "participants.find",
  "participants.some",
  "participants.every",
  "participants.length",
  "participants:",
  "metadata.participants",
  "requestParticipants",
  "participants.manage",
  "participants.request",
  "role === \"participant\"",
  "role !== \"participant\"",
  "role: \"participant\"",
  "\"participant\"",
  "'participant'",
  "`participant`",
  "app_chat_request_participants",
  "app_chat_get_participant_request_status",
  "app_participants_describe_options",
  "app_participants_request_change",
  "openSettingsSection(\"participants\")",
  "section === \"participants\"",
  "\"participants\"",
  "chatParticipant",
  "chatParticipants",
  "sourceParticipant",
  "sourceParticipantIds",
  "sourceParticipantLabels",
  "lastMessageByParticipant",
  "agentContextUsageByParticipant",
  "recordLastMessageByParticipant",
  "withParticipant",
  "readParticipant",
  "normalizeParticipant",
  "resolveParticipant",
  "selectedParticipant",
  "savedParticipant",
  "newParticipant",
  "targetParticipant",
  "requesterParticipant",
  "missingParticipant",
  "avatarForParticipant",
  "avatarForChatParticipant",
  "isChatAssistantParticipant",
  "renderParticipant",
  "onAddParticipant",
  "onRemoveParticipant",
  "setParticipants",
  "setParticipant",
  "ParticipantRequestDepthControl",
  "ParticipantRequestPromptMaxControl"
];

const internalRendererSnippets = [
  "className",
  "data-testid",
  "dataTestId",
  "testId",
  "participant-",
  "participants-",
  "settings-view-participants",
  "new URL(",
  "Generic Participant"
];

const internalMainSnippets = [
  "DEFAULT_ADMINISTRATOR_INSTRUCTIONS",
  "DEFAULT_ARBITER_INSTRUCTIONS",
  "DEFAULT_WORKFLOW_MANAGER_INSTRUCTIONS",
  "DEFAULT_GENERIC_PARTICIPANT_INSTRUCTIONS",
  "The requesting participant is no longer in this chat.",
  "Selected accord participants:",
  "## Participants",
  "Participants:",
  "request participants permission",
  "Do not choose roles marked archived for new participants",
  "For a new participant whose role does not exist",
  "saved participant preset",
  "saved participant IDs",
  "creating participant presets",
  "Counts saved participant presets",
  "AttachmentExportDenied.",
  "AttachmentImportDenied.",
  "sourcePath import permission could not be verified for this participant run",
  "this participant run has no allowed image import roots",
  "does not grant participant management",
  "Remote run output references a participant",
  "Remote run provider result references a participant",
  "Remote run permission request references a participant",
  "Remote run provider output references a participant",
  "This chat participant is not allowed to request tool permissions",
  "Choice request is not attached to a chat participant",
  "session.roleLabel} participant @",
  "Unknown role for @",
  "requested remote execution",
  "manage participants through these app tools",
  "needs a participant object",
  "Participant change request",
  "Participant operation",
  "Participant request",
  "Each participant request item",
  "Invalid participant target",
  "No participant named @",
  "A participant cannot request itself",
  "Deleting a role cannot be combined with participant changes"
];

test("renderer-visible copy uses member terminology", async () => {
  const failures = [];
  const files = await filesForRoots(rendererRoots);
  for (const file of files) {
    const relative = path.relative(repoRoot, file);
    if (isLegacyImplementationPlanSurface(relative)) {
      continue;
    }
    const lines = (await readFile(file, "utf8")).split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!participantTermPattern.test(line) || !hasVisibleCopyShape(line)) {
        return;
      }
      if (isAllowedRendererLine(relative, line)) {
        return;
      }
      failures.push(`${relative}:${index + 1}: ${line.trim()}`);
    });
  }

  assert.deepEqual(failures, []);
});

test("main-process user-facing errors and statuses use member terminology", async () => {
  const failures = [];
  for (const file of await filesForRoots(mainUserFacingFiles)) {
    const relative = path.relative(repoRoot, file);
    if (isLegacyImplementationPlanSurface(relative)) {
      continue;
    }
    const lines = (await readFile(file, "utf8")).split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!participantTermPattern.test(line) || !isMainUserFacingLine(line)) {
        return;
      }
      if (isAllowedMainLine(relative, line)) {
        return;
      }
      failures.push(`${relative}:${index + 1}: ${line.trim()}`);
    });
  }

  assert.deepEqual(failures, []);
});

test("known stale product phrases do not reappear", async () => {
  const failures = [];
  for (const file of await filesForRoots(exactCheckFiles)) {
    const relative = path.relative(repoRoot, file);
    if (isLegacyImplementationPlanSurface(relative)) {
      continue;
    }
    const lines = exactCheckContent(relative, await readFile(file, "utf8")).split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const snippet of staleProductSnippets) {
        if (!line.includes(snippet)) {
          continue;
        }
        if (isAllowedExactPhraseLine(relative, line, snippet)) {
          continue;
        }
        failures.push(`${relative}:${index + 1}: ${snippet}`);
      }
    });
  }

  assert.deepEqual(failures, []);
});

async function filesForRoots(roots) {
  const results = [];
  for (const root of roots) {
    const absolute = path.join(repoRoot, root);
    if (/\.(tsx?|md|mjs)$/.test(root)) {
      results.push(absolute);
    } else {
      results.push(...await sourceFiles(absolute));
    }
  }
  return results;
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await sourceFiles(fullPath));
    } else if (/\.(tsx?|md|mjs)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function isLegacyImplementationPlanSurface(relative) {
  return relative === "src/main/services/consensus.ts" ||
    relative.startsWith("src/renderer/components/review/");
}

function hasVisibleCopyShape(line) {
  return /["'`][^"'`]*\b[Pp]articipants?\b[^"'`]*["'`]/.test(line) ||
    />[^<{]*\b[Pp]articipants?\b[^<{]*</.test(line);
}

function isMainUserFacingLine(line) {
  return /throw new Error\(/.test(line) ||
    /\bmessage:\s*["'`]/.test(line) ||
    /\bsummary:\s*["'`]/.test(line) ||
    /\bstatusMessage:\s*["'`]/.test(line) ||
    /\btitle:\s*["'`]/.test(line) ||
    /\bdescription:\s*["'`]/.test(line) ||
    /\blabel:\s*["'`]/.test(line);
}

function isAllowedRendererLine(relative, line) {
  if (relative === "src/renderer/components/chat/chat-role-labels.ts") {
    return true;
  }
  return hasInternalShape(line) || internalRendererSnippets.some((snippet) => line.includes(snippet));
}

function isAllowedMainLine(relative, line) {
  if (relative === "src/main/services/chat.ts" && internalMainSnippets.some((snippet) => line.includes(snippet))) {
    return true;
  }
  if (relative === "src/main/services/settings.ts" && internalMainSnippets.some((snippet) => line.includes(snippet))) {
    return true;
  }
  return hasInternalShape(line);
}

function isAllowedExactPhraseLine(relative, line, snippet) {
  if (relative === "src/renderer/components/chat/chat-role-labels.ts" && snippet === "Generic Participant") {
    return true;
  }
  if (relative === "src/main/services/settings.ts" && isDefaultRoleInstructionLine(line)) {
    return true;
  }
  return isAllowedMainLine(relative, line) || isAllowedRendererLine(relative, line);
}

function isDefaultRoleInstructionLine(line) {
  return internalMainSnippets.some((snippet) => line.includes(snippet));
}

function hasInternalShape(line) {
  return internalLineSnippets.some((snippet) => line.includes(snippet));
}

function exactCheckContent(relative, content) {
  if (!relative.endsWith("/SKILL.md")) {
    return content;
  }
  const frontmatter = content.match(/^---\n[\s\S]*?\n---/);
  return frontmatter?.[0] ?? "";
}
