import { ipcMain } from "electron";
import type { CliImportListResult, CliImportRequest, CliImportResult } from "../../../shared/types";
import type { DesktopApp } from "../desktopApp";

let importing: Promise<unknown> = Promise.resolve();

/** Importing the User's own CLI threads as chats (docs/design/cli-import/plan.md). */
export function registerCliImportIpc(desktopApp: DesktopApp): void {
  ipcMain.handle("cli-import:list", () => listCliImportThreads(desktopApp));
  ipcMain.handle("cli-import:import", (_event, request: CliImportRequest) => {
    // One import at a time: two at once (New chat's Continue during the
    // dialog's import) could each make a chat of the same thread.
    const run = importing.then(() => importCliThreads(desktopApp, request));
    importing = run.catch(() => undefined);
    return run;
  });
}

/** The chat each CLI session already belongs to, by session id. */
async function chatsBySession(desktopApp: DesktopApp): Promise<Map<string, string>> {
  const rows = await desktopApp.storageService.listChatCliSessions();
  return new Map(rows.map((row) => [row.sessionId, row.conversationId]));
}

async function listCliImportThreads(desktopApp: DesktopApp): Promise<CliImportListResult> {
  const [found, known] = await Promise.all([desktopApp.cliImportService.list(), chatsBySession(desktopApp)]);
  return {
    ...found,
    threads: found.threads.map((thread) => {
      const conversationId = known.get(thread.sessionId);
      return conversationId ? { ...thread, conversationId } : thread;
    })
  };
}

/** One thread at a time: each is read whole (a long one is thousands of
 *  messages) and saved before the next is read. */
async function importCliThreads(desktopApp: DesktopApp, request: CliImportRequest): Promise<CliImportResult> {
  const result: CliImportResult = { imported: [], failed: [] };
  const known = await chatsBySession(desktopApp);
  for (const ref of request?.threads ?? []) {
    const already = known.get(ref.sessionId);
    if (already) {
      result.imported.push({ sessionId: ref.sessionId, conversationId: already });
      continue;
    }
    try {
      const thread = await desktopApp.cliImportService.readHistory({ kind: ref.kind, sessionId: ref.sessionId });
      const conversation = await desktopApp.chatService.importCliThread(thread, ref.folder);
      known.set(ref.sessionId, conversation.id);
      result.imported.push({ sessionId: ref.sessionId, conversationId: conversation.id });
    } catch (error) {
      result.failed.push({ sessionId: ref.sessionId, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
