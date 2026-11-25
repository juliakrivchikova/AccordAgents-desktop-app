import type { ChatParticipant, Conversation } from "../../../../shared/types";
import type { ChatAppMcpTokenGrant } from "../types";
import type { ChatDependencies } from "../dependencies";

/** The app tool connection each member's CLI process holds. */
export class AppMcpGrants {
  readonly appMcpTokens = new Map<string, string>();
  /** The last app tool grant issued to each member's CLI process, so a reply
   *  the CLI starts on its own can be given its own run and thread. */
  readonly lastAppMcpGrants = new Map<string, ChatAppMcpTokenGrant>();
  /** The connection (url, token) each member's CLI was given, reused by a
   *  Claude Code turn that must not retarget the token before its message
   *  reaches the step (see runParticipantTurn). */
  readonly appMcpConnections = new Map<string, { url: string; token: string }>();

  constructor(private readonly deps: Pick<ChatDependencies, "appMcp">) {}

  issueAppMcpConnection(
    conversation: Conversation,
    participant: ChatParticipant,
    grant: ChatAppMcpTokenGrant
  ): { url: string; token: string } | undefined {
    if (!this.deps.appMcp) {
      return undefined;
    }
    const key = `${conversation.id}:${participant.id}`;
    const existingToken = this.appMcpTokens.get(key);
    if (existingToken && this.deps.appMcp.updateToken) {
      const updated = this.deps.appMcp.updateToken(existingToken, grant);
      if (updated) {
        this.appMcpConnections.set(key, updated);
        return updated;
      }
      this.appMcpTokens.delete(key);
      this.appMcpConnections.delete(key);
    }
    const issued = this.deps.appMcp.issueToken(grant);
    if (issued) {
      this.appMcpTokens.set(key, issued.token);
      this.appMcpConnections.set(key, issued);
    }
    return issued;
  }
}
