import type { ChatEventAppendResult } from "../../shared/chatEvents";
import { assertChatEventsCanEnterSyncNetwork } from "../../shared/chatEventResidency";
import type { Conversation } from "../../shared/types";
import type { StorageService } from "./storage";
import type { MailboxAppendAck, MailboxRangeRequest, MailboxSyncClient } from "./mailboxSyncClient";

export interface MailboxPushResult {
  pushedEventIds: string[];
  ack: MailboxAppendAck;
}

export interface MailboxPullResult {
  receivedEventIds: string[];
  appendResults: ChatEventAppendResult[];
}

export class MailboxSyncService {
  constructor(
    private readonly storage: StorageService,
    private readonly mailbox: MailboxSyncClient
  ) {}

  async pushConversationEvents(conversation: Conversation, logScopeId: string = conversation.id): Promise<MailboxPushResult> {
    const events = await this.storage.listChatEvents(conversation.id, logScopeId);
    assertChatEventsCanEnterSyncNetwork(conversation, events);
    const ack = await this.mailbox.appendEvents(events);
    return {
      pushedEventIds: ack.eventIds,
      ack
    };
  }

  async pullMailboxRange(request: MailboxRangeRequest): Promise<MailboxPullResult> {
    const events = await this.mailbox.listEvents(request);
    const appendResults = await this.storage.appendChatEvents(events);
    return {
      receivedEventIds: events.map((event) => event.eventId),
      appendResults
    };
  }
}
