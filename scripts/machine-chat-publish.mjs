/**
 * The desktop's chat changes, for scripts that drive a MachineLinkService
 * without a ChatService: a chat is published the way ChatService saves it,
 * as one signed chat change event for every enrolled machine, committed with
 * the save.
 *
 * `seed` lets a script state messages the desktop would not author itself
 * (a member's reply that in real use arrives from the machine), so a scenario
 * can start from a chat that already holds them.
 */
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "..");
const { createChatChangeTransport } = require(path.join(repoRoot, "dist/main/main/services/chatChangeTransport.js"));
const { chatChangeBaseline, diffChatChanges } = require(path.join(repoRoot, "dist/main/main/services/chatChanges.js"));

export function chatPublisher({ storage, log, link }) {
  const transport = createChatChangeTransport({
    role: "desktop", storage, log,
    recipients: () => link.chatActionRecipients(),
    onCommitted: () => link.nudgeEventChannels()
  });
  const baselines = new Map();
  return {
    head: (conversationId) => transport.head(conversationId),
    async publish(conversation, { seed = false } = {}) {
      const policy = seed ? { emitsConversationFields: true, ownsMessage: () => true } : transport.diffPolicy(conversation);
      const { changes } = diffChatChanges(baselines.get(conversation.id), conversation, policy);
      if (!changes.length) return;
      await transport.commit({ version: 1, conversationId: conversation.id, updatedAt: conversation.updatedAt, changes },
        (also) => storage.saveConversation(conversation, { alsoCommit: also }));
      baselines.set(conversation.id, chatChangeBaseline(JSON.parse(JSON.stringify(conversation))));
    }
  };
}
