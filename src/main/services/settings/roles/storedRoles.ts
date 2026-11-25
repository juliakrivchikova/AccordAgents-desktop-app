import { MAIN_SESSION_ROLE_ID } from "../../../../shared/mainSession";
import { randomUUID } from "node:crypto";
import type { ChatParticipantConfig, ChatRoleConfig, ChatRoleParticipantDefaults } from "../../../../shared/types";
import {
  normalizeChatParticipantRequestPermission, normalizeChatRoleManagementPermission,
  normalizeOptionalChatParticipantRequestPermission
} from "../../../../shared/agentPermissions";
import { hasChatAppToolCapability, normalizeChatAppToolCapabilities } from "../../../../shared/appTools";
import { DEFAULT_CHAT_ROLES } from "./defaultRoles";
import { WORKFLOW_MANAGER_ROLE_ID } from "./roleIds";

// Counts saved participant presets bound to a role. This is the reliable,
// settings-local usage count that gates deletion (see chat-roles docs).
export function roleParticipantUsageCount(roleId: string, participants: ChatParticipantConfig[]): number {
  return participants.filter((participant) => participant.roleConfigId === roleId).length;
}

export function shouldMigrateWorkflowManagerParticipantManagement(roles: ChatRoleConfig[] | undefined): boolean {
  const existing = Array.isArray(roles) ? roles.find((role) => role.id === WORKFLOW_MANAGER_ROLE_ID) : undefined;
  const fallback = DEFAULT_CHAT_ROLES.find((role) => role.id === WORKFLOW_MANAGER_ROLE_ID);
  return !existing || (existing.builtIn === true && fallback !== undefined && existing.version < fallback.version);
}

export function mergeDefaultRoles(roles: ChatRoleConfig[] | undefined): ChatRoleConfig[] {
  const existing = Array.isArray(roles) ? roles : [];
  const merged = DEFAULT_CHAT_ROLES.map((fallback) => {
    const role = existing.find((item) => item.id === fallback.id);
    if (!role) {
      return fallback;
    }
    if (role.builtIn && role.version < fallback.version) {
      return fallback;
    }
    return role;
  });
  const custom = existing.filter((role) => !DEFAULT_CHAT_ROLES.some((fallback) => fallback.id === role.id));
  return [...merged, ...custom]
    .filter((role) => role.id.trim() && role.label.trim() && role.instructions.trim())
    .map((role) => ({
      ...role,
      appToolCapabilities: normalizeChatAppToolCapabilities(role.appToolCapabilities),
      participantDefaults: normalizeRoleParticipantDefaultsForRole(role, role.participantDefaults)
    }));
}

export function normalizeRoleParticipantDefaults(value: unknown): ChatRoleParticipantDefaults {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      autoWatch: false,
      requestParticipants: "ask",
      requestCompaction: "ask",
      manageRolesParticipants: "deny"
    };
  }
  const record = value as Partial<ChatRoleParticipantDefaults>;
  const requestParticipants = normalizeChatParticipantRequestPermission(record.requestParticipants);
  const requestCompaction = normalizeChatParticipantRequestPermission(record.requestCompaction);
  const manageRolesParticipants = normalizeChatRoleManagementPermission(record.manageRolesParticipants);
  return {
    autoWatch: record.autoWatch === true,
    requestParticipants,
    requestCompaction,
    manageRolesParticipants
  };
}

export function normalizeRoleParticipantDefaultsForRole(
  role: string | Pick<ChatRoleConfig, "id" | "appToolCapabilities">,
  value: unknown,
  options: { inferLegacyManage?: boolean } = {}
): ChatRoleParticipantDefaults {
  const roleId = typeof role === "string" ? role : role.id;
  const normalized = normalizeRoleParticipantDefaults(value);
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<ChatRoleParticipantDefaults>
    : {};
  const hasExplicitManage = normalizeOptionalChatParticipantRequestPermission(record.manageRolesParticipants) !== undefined;
  const legacyManage = options.inferLegacyManage !== false &&
    !hasExplicitManage &&
    typeof role !== "string" &&
    hasChatAppToolCapability(role.appToolCapabilities, "participants.manage");
  const withRolePolicy = {
    ...normalized,
    manageRolesParticipants: roleId === "administrator" || legacyManage
      ? "ask"
      : normalized.manageRolesParticipants
  } satisfies ChatRoleParticipantDefaults;
  if (roleId === MAIN_SESSION_ROLE_ID) {
    // The main session asks members and adds them without a card
    // (docs/main-session.md); its stored copy cannot take that away.
    return {
      ...withRolePolicy,
      requestParticipants: "allow",
      manageRolesParticipants: "allow"
    };
  }
  return roleId === WORKFLOW_MANAGER_ROLE_ID
    ? {
        ...withRolePolicy,
        autoWatch: true,
        requestParticipants: "allow",
        manageRolesParticipants: "allow"
      }
    : withRolePolicy;
}

export function autoWatchEnabledForRole(role: Pick<ChatRoleConfig, "id">, value: unknown): boolean {
  return role.id === WORKFLOW_MANAGER_ROLE_ID || value === true;
}

export function roleIdFromLabel(label: string): string {
  const slug = (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "role"
  );
  return `custom-${slug}-${randomUUID().slice(0, 8)}`;
}

export function uniqueRoleId(label: string, roles: ChatRoleConfig[]): string {
  let id = roleIdFromLabel(label);
  while (roles.some((role) => role.id === id)) {
    id = roleIdFromLabel(label);
  }
  return id;
}
