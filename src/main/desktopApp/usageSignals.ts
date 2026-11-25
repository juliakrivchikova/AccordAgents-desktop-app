import type { UrgentAlertSettingsView } from "../../shared/urgentAlerts";
import { app } from "electron";
import { sendUsageSignal } from "../services/crashReporting";
import { UsageMilestones, usageActiveChatViews, usageFeatureHistoryFrom, usageHistoryFrom } from "../services/usageMilestones";
import {
  USAGE_ACTIVE_CHAT_WINDOW_MS, usageCustomRoleCount, usageLocale, usageMultiRoleChat, usageOs, usageRoleChosen,
  usageWeeklySnapshot
} from "../../shared/usageSignals";
import type { DesktopApp } from "./desktopApp";

export const DESKTOP_LINK_STARTUP_GRACE_MS = 60_000;

/** How often an open app looks whether this week's snapshot is still due. */
export const USAGE_SNAPSHOT_CHECK_MS = 6 * 60 * 60 * 1000;

/** How long the usage history waits for the server to say whether alerts
 *  were set up (the link may still be starting, or the server updating). */
const USAGE_ALERTS_HISTORY_WAIT_MS = 3 * 60_000;

export function createUsageSignals(desktopApp: DesktopApp): void {
  /** The once-per-installation usage signals; only in a launch with reports
   *  on, and only on the computer (a machine's runtime has none). */
  desktopApp.usageMilestones = desktopApp.crashReportingStart.active
    ? new UsageMilestones({
      userDataDir: app.getPath("userData"),
      profileUsedBefore: desktopApp.profileUsedBeforeLaunch,
      send: sendUsageSignal,
      installFacts: () => ({
        os: usageOs(process.platform),
        appVersion: app.getVersion(),
        locale: usageLocale([...app.getPreferredSystemLanguages(), app.getSystemLocale(), app.getLocale()]),
        teamDevice: desktopApp.teamDevice
      }),
      readHistory: async () => {
        const [chats, documents, machines] = await Promise.all([
          desktopApp.storageService.listChatMemberProviders(),
          desktopApp.artifactStore.multiSignerDocumentStatus(),
          desktopApp.settingsService.listMachines()
        ]);
        return usageHistoryFrom(chats, documents, machines.length);
      },
      readFeatureHistory: async () => {
        // A source that cannot be read leaves its features counted as used.
        const soft = <T>(read: Promise<T>): Promise<T | undefined> => read.catch(() => undefined);
        const [chats, settings, documents, scripts, memoryNotes, devices, alerts] = await Promise.all([
          soft(desktopApp.storageService.listChatMemberProviders()),
          soft(desktopApp.settingsService.getPublicSettings()),
          soft(desktopApp.artifactStore.multiSignerDocumentStatus()),
          soft(desktopApp.scriptService.list()),
          soft(desktopApp.memoryMirror.size()),
          soft(desktopApp.settingsService.listTrustedDevices()),
          // Not softened: without the server's answer the history is read again
          // next launch, so an old setup is neither sent nor assumed.
          readUrgentAlertSettingsForHistory(desktopApp)
        ]);
        return usageFeatureHistoryFrom({
          chats,
          roles: settings?.chatRoleConfigs,
          savedMembers: settings?.chatParticipantConfigs,
          plainDocument: documents?.plain,
          approvedScheduledTasks: scripts?.filter((script) => script.approved).length,
          memoryNotes,
          phones: devices?.filter((device) => device.role === "phone").length,
          urgentAlerts: alerts !== null && (alerts.telegram?.connected === true || Boolean(alerts.phone))
        });
      },
      readWeeklySnapshot: async (week) => {
        // Chats in use the seven days before, by their view (docs/main-session.md).
        const activeSince = new Date(Date.now() - USAGE_ACTIVE_CHAT_WINDOW_MS).toISOString();
        const [chats, settings, activeChats] = await Promise.all([
          desktopApp.storageService.listChatMemberProviders(),
          desktopApp.settingsService.getPublicSettings(),
          desktopApp.storageService.listChatViewsWithUserMessagesSince(activeSince)
        ]);
        return usageWeeklySnapshot(week, chats, usageCustomRoleCount(settings.chatRoleConfigs), usageActiveChatViews(activeChats));
      },
      readDocuments: (since, plainSince) => desktopApp.artifactStore.multiSignerDocumentStatus(since, plainSince),
      log: (event, payload) => {
        void desktopApp.debugLogService.write(event, payload);
      }
    })
    : undefined;

  const { usageMilestones } = desktopApp;
  // Saves of roles and saved members (from Settings, or by a member after the
  // User approved it) are the first uses of roles and behavior rules.
  desktopApp.settingsService.setUsageObserver(usageMilestones ? (event) => {
    if (event.kind === "role-created") {
      usageMilestones.reach("custom_role_created");
      return;
    }
    if (event.roleChosen) usageMilestones.reach("member_role_changed");
    if (event.rulesAdded) usageMilestones.reach("behavior_rule_attached");
  } : undefined);

  desktopApp.cliAgentRunner.setAgentsDetectedObserver(usageMilestones ? (agents) => usageMilestones.observeAgents(agents) : undefined);
}

/** The alert settings for the usage history: null when this server has no
 *  alerts to set up (an older server, or a device that may not set them).
 *  Throws when the server does not answer in time, so the whole history is
 *  read again next launch rather than guessed. */
async function readUrgentAlertSettingsForHistory(desktopApp: DesktopApp): Promise<UrgentAlertSettingsView | null> {
  const deadline = Date.now() + USAGE_ALERTS_HISTORY_WAIT_MS;
  while (Date.now() < deadline) {
    const result = await desktopApp.serverChatLink.alerts<UrgentAlertSettingsView>({ action: "settings" }, AbortSignal.timeout(Math.max(1000, deadline - Date.now())));
    if (result.ok) return result.value;
    if (result.error.code !== "server_unavailable" || /older than this app/.test(result.error.message)) return null;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error("The server did not say whether alerts are set up.");
}

/** A member added to a chat from this computer: a role someone chose, rules,
 *  and a chat whose members have different roles now but did not before. */
export function observeAddedMember(desktopApp: DesktopApp, 
  member: { handle?: string; roleConfigId?: string; behaviorRuleIds?: string[] },
  chatMembers: ReadonlyArray<{ handle?: string; roleConfigId?: string }>
): void {
  if (!desktopApp.usageMilestones) return;
  if (usageRoleChosen(member.roleConfigId)) desktopApp.usageMilestones.reach("member_role_changed");
  if ((member.behaviorRuleIds?.length ?? 0) > 0) desktopApp.usageMilestones.reach("behavior_rule_attached");
  const handle = member.handle?.trim().replace(/^@/, "").toLowerCase();
  const before = chatMembers.filter((other) => other.handle?.toLowerCase() !== handle);
  if (usageMultiRoleChat(chatMembers) && !usageMultiRoleChat(before)) desktopApp.usageMilestones.reach("multi_role_chat");
}
