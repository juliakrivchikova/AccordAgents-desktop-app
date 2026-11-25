import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { userDataPath } from "../../../platform";
import type { Conversation } from "../../../../shared/types";
import { conversationForMembers } from "../members/identity";
import { historyMarkdown } from "./historyText";

/** The chat's history as files its members can read. */
export class ChatHistory {
  async ensureHistoryFiles(conversation: Conversation): Promise<string> {
    const dir = path.join(userDataPath(), "chats", conversation.id);
    await mkdir(dir, { recursive: true });
    const markdown = historyMarkdown(conversation);
    await Promise.all([
      writeFile(path.join(dir, "history.md"), markdown, "utf8"),
      // The members' copy: a turn-finished note points back at a reply that
      // is here in full, as in history.md and the read tool.
      writeFile(path.join(dir, "history.json"), `${JSON.stringify(conversationForMembers(conversation), null, 2)}\n`, "utf8")
    ]);
    return dir;
  }
}
