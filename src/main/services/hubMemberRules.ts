import { normalizeChatRoleManagementPermission, normalizeOptionalChatParticipantRequestPermission } from "../../shared/agentPermissions";
import type { HubMemberRules } from "../../shared/hubProtocol";
import type { ChatParticipantConfig, ChatRoleConfig } from "../../shared/types";
import type { HubClient } from "./hubClient";

/**
 * The User's rules for members (her roles and saved members), put on her
 * server: the server holds a cloud machine's changes to a chat's members to
 * them, as the app holds a member on this computer (src/hub/hubMachineScope.ts).
 * Published whatever else is paired, whenever they change, and again until
 * the server has them.
 */

export function memberRulesFrom(settings: { chatRoleConfigs: ChatRoleConfig[]; chatParticipantConfigs: ChatParticipantConfig[] }): HubMemberRules {
  const roles: HubMemberRules["roles"] = {};
  for (const role of settings.chatRoleConfigs) {
    const requestParticipants = normalizeOptionalChatParticipantRequestPermission(role.participantDefaults?.requestParticipants);
    const requestCompaction = normalizeOptionalChatParticipantRequestPermission(role.participantDefaults?.requestCompaction);
    roles[role.id] = {
      manageRolesParticipants: normalizeChatRoleManagementPermission(role.participantDefaults?.manageRolesParticipants),
      ...(requestParticipants ? { requestParticipants } : {}),
      ...(requestCompaction ? { requestCompaction } : {})
    };
  }
  const presets: HubMemberRules["presets"] = {};
  for (const preset of settings.chatParticipantConfigs) {
    presets[preset.id] = {
      handle: preset.handle,
      roleConfigId: preset.roleConfigId,
      ...(preset.homeMachineId ? { homeMachineId: preset.homeMachineId } : {}),
      ...(preset.agentMode ? { agentMode: preset.agentMode } : {}),
      ...(preset.permissions ? { permissions: preset.permissions } : {})
    };
  }
  return { version: 1, roles, presets };
}

const RETRY_FIRST_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;

export class HubMemberRulesPublisher {
  private queue: Promise<void> = Promise.resolve();
  private published?: string;
  private retry?: ReturnType<typeof setTimeout>;
  private retryMs = RETRY_FIRST_MS;

  constructor(private readonly options: {
    client: () => HubClient | undefined;
    rules: () => Promise<HubMemberRules>;
    log: (event: string, payload: Record<string, unknown>) => void;
  }) {}

  /** Another server (or the first): it gets the rules again. */
  reset(): void {
    this.published = undefined;
  }

  /** Soon after `delayMs` (a burst of setting writes is one publish). */
  publish(delayMs = 0): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    if (delayMs > 0) {
      this.retry = setTimeout(() => { this.retry = undefined; this.publish(); }, delayMs);
      this.retry.unref?.();
      return;
    }
    this.queue = this.queue.then(() => this.publishNow()).catch((error: unknown) => {
      this.options.log("hub.member-rules.error", { message: error instanceof Error ? error.message : String(error), retryMs: this.retryMs });
      if (this.retry) clearTimeout(this.retry);
      this.retry = setTimeout(() => { this.retry = undefined; this.publish(); }, this.retryMs);
      this.retry.unref?.();
      this.retryMs = Math.min(RETRY_MAX_MS, this.retryMs * 2);
    });
  }

  private async publishNow(): Promise<void> {
    const client = this.options.client();
    if (!client) return;
    const rules = await this.options.rules();
    const content = JSON.stringify(rules);
    if (content === this.published) return;
    await client.setMemberRules(rules);
    this.published = content;
    this.retryMs = RETRY_FIRST_MS;
    this.options.log("hub.member-rules.published", { roles: Object.keys(rules.roles).length, presets: Object.keys(rules.presets).length });
  }
}
