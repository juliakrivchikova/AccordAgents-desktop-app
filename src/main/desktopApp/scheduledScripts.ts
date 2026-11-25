import path from "node:path";
import { app } from "electron";
import { ScriptService } from "../services/scripts";
import { ScriptHub } from "../services/scriptHub";
import { ScriptSecretStore, ScriptStore } from "../services/scriptStore";
import { hostPlatform } from "../platform";
import { SCRIPT_DESKTOP_HOST_ID } from "../../shared/scripts";
import { emitReviewProgress } from "./chatServices";
import { sendToMainWindow } from "./windowState";
import type { DesktopApp } from "./desktopApp";

export function createScheduledScripts(desktopApp: DesktopApp): void {
  desktopApp.scriptService = new ScriptService({
    store: new ScriptStore(path.join(app.getPath("userData"), "scripts")),
    secrets: new ScriptSecretStore(path.join(app.getPath("userData"), "script-secrets.json"), hostPlatform().secrets),
    hostId: SCRIPT_DESKTOP_HOST_ID,
    hostLabel: process.platform === "darwin" ? "This Mac" : "This computer",
    hostPhrase: process.platform === "darwin" ? "this Mac" : "this computer",
    tokens: desktopApp.appMcpService,
    chat: {
      describeChat: (chatId) => desktopApp.chatService.describeChatForScripts(chatId),
      postScriptMessage: (input) => desktopApp.chatService.postScriptMessage({ ...input, progress: (progress) => emitReviewProgress(desktopApp, progress) })
    },
    node: { command: "node", env: {} },
    debugLog: (event, payload) => {
      void desktopApp.debugLogService.write(event, payload);
    },
    onChanged: () => broadcastScripts(desktopApp, [])
  });

  // Every script the desktop can show: its own and those on its machines.
  desktopApp.scriptHub = new ScriptHub(desktopApp.scriptService, () => desktopApp.machineLinkService);

  /** Machines to ask afresh in the next broadcast; undefined means all. */
  desktopApp.scriptsRefresh = new Set();

  /** Lists can take seconds; one that finishes after a newer one is dropped. */
  desktopApp.scriptsBroadcastSeq = 0;

  // A scheduled task the User approved on this computer is its first use.
  desktopApp.chatService.setScriptHost({
    proposeChange: (input) => desktopApp.scriptService.proposeChange(input),
    attachApproval: (scriptId, approvalId, revisionId) => desktopApp.scriptService.attachApproval(scriptId, approvalId, revisionId),
    assertApprovable: (request) => desktopApp.scriptService.assertApprovable(request),
    applyApproved: async (request) => {
      const applied = await desktopApp.scriptService.applyApproved(request);
      if (request.op === "create") desktopApp.usageMilestones?.reach("scheduled_task_created");
      return applied;
    },
    rejectPending: (request) => desktopApp.scriptService.rejectPending(request),
    listForAgent: (conversationId) => desktopApp.scriptService.listForAgent(conversationId),
    runs: (id, conversationId, limit) => desktopApp.scriptService.runs(id, conversationId, limit)
  });

  desktopApp.appMcpService.setScriptApiHandler((context, _route, body) => desktopApp.scriptService.postFromScript(context, body));
}

/** Tells the window the scripts changed. Only the machines that said so are
 *  asked again; the rest are shown from their last answer. */
export function broadcastScripts(desktopApp: DesktopApp, refresh?: string[]): void {
  if (!refresh) desktopApp.scriptsRefresh = undefined;
  else for (const machineId of refresh) desktopApp.scriptsRefresh?.add(machineId);
  if (desktopApp.scriptsUpdatedTimer) return;
  desktopApp.scriptsUpdatedTimer = setTimeout(() => {
    desktopApp.scriptsUpdatedTimer = undefined;
    const machines = desktopApp.scriptsRefresh ? [...desktopApp.scriptsRefresh] : undefined;
    desktopApp.scriptsRefresh = new Set();
    const seq = ++desktopApp.scriptsBroadcastSeq;
    void desktopApp.scriptHub.list(machines)
      .then((scripts) => { if (seq === desktopApp.scriptsBroadcastSeq) sendToMainWindow(desktopApp, "scripts:updated", { scripts }); })
      .catch(() => undefined);
  }, 150);
}
