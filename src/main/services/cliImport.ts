import { homedir } from "node:os";
import type { ChatProviderKind, CliImportListRequest, CliImportListResult } from "../../shared/types";
import { commandEnvironment } from "./command";
import { AgyThreads } from "./cliImport/agyThreads";
import { ClaudeThreads } from "./cliImport/claudeThreads";
import { CodexThreads } from "./cliImport/codexThreads";
import { listCliThreads } from "./cliImport/threadList";
import type { CliImportDependencies, CliImportHistory, CliThreadReader } from "./cliImport/types";

export type { CliImportDependencies, CliImportHistory, CliImportHistoryEntry } from "./cliImport/types";

/** The User's own CLI threads on this computer (Claude Code, Codex, agy),
 *  listed and read from each CLI's own store, for importing one as a chat
 *  (docs/design/cli-import/plan.md). The work is done by ./cliImport. */
export class CliImportService {
  private readonly readers: Record<ChatProviderKind, CliThreadReader>;

  constructor(deps: CliImportDependencies) {
    const env = deps.env ?? (() => commandEnvironment());
    this.readers = {
      "claude-code": new ClaudeThreads(env),
      "codex-cli": new CodexThreads({ codexExecutable: deps.codexExecutable, env }),
      "gemini-cli": new AgyThreads({ sqliteExecutable: deps.sqliteExecutable, homeDir: deps.homeDir ?? homedir() })
    };
  }

  /** Every CLI's threads, newest first (`conversationId` is left for the
   *  caller, which knows the chats). */
  list(request: CliImportListRequest): Promise<CliImportListResult> {
    return listCliThreads(Object.values(this.readers), request);
  }

  readHistory(ref: { kind: ChatProviderKind; sessionId: string }): Promise<CliImportHistory> {
    return this.readers[ref.kind].readHistory(ref.sessionId);
  }
}
