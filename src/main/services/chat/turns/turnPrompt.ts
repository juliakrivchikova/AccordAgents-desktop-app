import { chatViewFor, isMainSessionParticipant } from "../../../../shared/mainSession";
import { choicesClosedByMessage } from "../../chatChoiceExpiry";
import type {
  ChatAgentMode, ChatAgentPermissions, ChatMessage, ChatParticipant, ChatParticipantSession, Conversation
} from "../../../../shared/types";
import { isAdministratorSession } from "../members/identity";
import { memoryIndexKey } from "../members/roleRuntime";
import {
  ANTIGRAVITY_READ_ONLY_NOTE, antigravityAccessLines, antigravityReadOnly, appNotesBlock, chatAssistantPermissionPolicy,
  compactionAccessLines, handleWritingLines, idleLargeMembersNote, initialAutoTitlePromptSection, newMessageNonce, notAsCliCommand,
  participantPermissionPolicy, participantRepositoryLine, repoFileMentionsPromptSection, scheduledTaskAccessLines,
  skillMentionsPromptSection, triggerPromptText
} from "./promptSections";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

interface ChatPromptSectionSizes {
  /** The session's instructions, given in the message (a session that must
   *  be told them again, Antigravity's first message). */
  staticEnvelope: number;
  /** The note that the member's access changed since it was told. */
  accessNote: number;
  identityNote: number;
  moveNote: number;
  promptContext: number;
  closedChoices: number;
  /** The main session's note of members idle long with a large context. */
  idleLargeMembers: number;
  trigger: number;
  skills: number;
  mentions: number;
  unavailableImages: number;
  continuationNote: number;
  readOnlyNote: number;
  autoTitle: number;
  memory: number;
  /** Pictures given to the CLI as images (not counted in total). */
  images: number;
  total: number;
}

interface ChatPromptBuildOptions {
  includeRoleInstructions: boolean;
  /** This message's nonce (8 hex characters, new for every message): its
   *  app notes and every block of text someone other than User wrote carry
   *  it (buildPromptParts). The same for every variant of one turn's
   *  prompt, and for its unseen-chat block. */
  turnNonce?: string;
  agentMode: ChatAgentMode;
  permissions: ChatAgentPermissions;
  promptContextBlock?: string;
  memoryIndexBlock?: string;
  moveNoteBlock?: string;
  identityNoteBlock?: string;
  /** Said when the member's access differs from what its session was told
   *  (accessChangedNote). */
  accessNote?: string;
  /** The message's pictures that could not be loaded, said in words. */
  unavailableImagesNote?: string;
  /** The message's pictures named for the attachment tools, for a CLI that
   *  takes no image input (Antigravity). */
  picturesNote?: string;
  /** How many pictures go to the CLI as images (for the size log). */
  imageCount?: number;
}

/** Goes with a resume that brings the replies of the members it asked. */
const CONTINUATION_HANDLE_NOTE = "When you name these members in your reply, write their names without the @ (or in backticks): an @handle asks that member to run again.";

/** The text of a turn: what the member is told with the message. */
export class TurnPrompt {
  constructor(
    private readonly chat: Pick<ChatModules, "choiceExpiry" | "memberSessions" | "permissionRequests">,
    private readonly deps: Pick<ChatDependencies, "cliRunner">
  ) {}

  buildPrompt(
    conversation: Conversation,
    participant: ChatParticipant,
    session: ChatParticipantSession,
    triggerMessage: ChatMessage,
    workspacePath: string,
    continuation: boolean,
    options: ChatPromptBuildOptions
  ): string {
    return this.buildPromptParts(conversation, participant, session, triggerMessage, workspacePath, continuation, options).prompt;
  }

  /**
   * What a member's CLI gets for one message. Everything said once lives in
   * the session's instructions (sessionInstructions), so an ordinary message
   * of User's is exactly what she typed, as in the dedicated CLI. Around it
   * only what happened since the member was last told: its instructions when
   * the session must be given them again, a change of its access, a note
   * about its session (a fork, a move, its memory), chat messages it has not
   * seen (as data), a choice card closed without an answer, and the
   * message's selected skills and files.
   */
  buildPromptParts(
    conversation: Conversation,
    participant: ChatParticipant,
    session: ChatParticipantSession,
    triggerMessage: ChatMessage,
    workspacePath: string,
    continuation: boolean,
    options: ChatPromptBuildOptions
  ): { prompt: string; sections: ChatPromptSectionSizes } {
    const canRequestPermissions = this.chat.permissionRequests.canRequestPermissionChanges(session);
    const nonce = options.turnNonce ?? newMessageNonce();
    const staticEnvelope = options.includeRoleInstructions
      ? [
          "AccordAgents session instructions (from now on they apply instead of any given earlier):",
          this.chat.memberSessions.sessionInstructions(conversation, participant, session, options, workspacePath)
        ].join("\n")
      : "";
    const accessNote = staticEnvelope ? "" : options.accessNote ?? "";
    const identityNote = options.identityNoteBlock ?? "";
    const moveNote = options.moveNoteBlock ?? "";
    const memoryIndexBlock = options.memoryIndexBlock ?? "";
    const promptContextBlock = options.promptContextBlock ?? "";
    const closedChoicesNote = this.closedChoicesPromptSection(conversation, participant, triggerMessage);
    const idleLargeNote = idleLargeMembersNote(conversation, participant, options.permissions);
    const autoTitleBlock = initialAutoTitlePromptSection(conversation, participant, triggerMessage);
    const triggerBlock = triggerPromptText(participant, triggerMessage, nonce);
    const skillsBlock = skillMentionsPromptSection(triggerMessage, participant.kind);
    const mentionsBlock = repoFileMentionsPromptSection(
      triggerMessage,
      participant.kind,
      options.agentMode,
      options.permissions,
      canRequestPermissions,
      isAdministratorSession(session)
    );
    const unavailableImagesBlock = [options.picturesNote ?? "", options.unavailableImagesNote ?? ""].filter(Boolean).join("\n\n");
    // Resumed with the replies of the members it asked, a member tends to
    // name them by handle when it sums them up, and each @handle asks that
    // member to run again (seen in QA on 2026-11-22: four rounds of "Noted").
    // The rule is in its instructions; this one line goes with these
    // resumes only. In the sessions view a handle starts nobody
    // (handleWritingLines), so there is nothing to warn about.
    const continuationNote = continuation && chatViewFor(conversation.metadata) !== "sessions" ? CONTINUATION_HANDLE_NOTE : "";
    // Antigravity has no read-only sandbox of its own (geminiExec): a
    // read-only member is reminded with every message.
    // (Not when its access is said in this message already.)
    const readOnlyNote = participant.kind === "gemini-cli" && !staticEnvelope && !accessNote && antigravityReadOnly(options.agentMode, options.permissions)
      ? ANTIGRAVITY_READ_ONLY_NOTE
      : "";

    // The app's notes first, then the chat it has not seen (as data), then
    // the message itself, then the app's notes on it. Only User's own words
    // stand outside a block carrying this message's nonce: the app's notes
    // are in APP blocks, and whatever someone else wrote is in a block of its
    // own (triggerPromptText, promptContextBlock), so no text a member or a
    // task wrote can pass for User's or the app's (messageDeliveryInstructions).
    // Members' long-term memory is their text: titles any member may write.
    const memoryBlock = memoryIndexBlock ? [`<<<MEMORY ${nonce}>>>`, memoryIndexBlock, `<<<END MEMORY ${nonce}>>>`].join("\n") : "";
    const orderedBlocks = [
      appNotesBlock(nonce, [identityNote, staticEnvelope, accessNote, moveNote]),
      memoryBlock,
      promptContextBlock,
      appNotesBlock(nonce, [closedChoicesNote, idleLargeNote, autoTitleBlock]),
      triggerBlock,
      appNotesBlock(nonce, [skillsBlock, mentionsBlock, unavailableImagesBlock, readOnlyNote, continuationNote])
    ].filter(Boolean);
    const prompt = notAsCliCommand(orderedBlocks.join("\n\n"));

    return {
      prompt,
      sections: {
        staticEnvelope: staticEnvelope.length,
        accessNote: accessNote.length,
        identityNote: identityNote.length,
        moveNote: moveNote.length,
        promptContext: promptContextBlock.length,
        closedChoices: closedChoicesNote.length,
        idleLargeMembers: idleLargeNote.length,
        trigger: triggerBlock.length,
        skills: skillsBlock.length,
        mentions: mentionsBlock.length,
        unavailableImages: unavailableImagesBlock.length,
        continuationNote: continuationNote.length,
        readOnlyNote: readOnlyNote.length,
        autoTitle: autoTitleBlock.length,
        memory: memoryIndexBlock.length,
        images: options.imageCount ?? 0,
        total: prompt.length
      }
    };
  }

  /** Takes the compactions the member's live Claude Code process ran since
   *  last asked (cliAgents counts them whatever reply they happened in): any
   *  makes its next turn say its access again (accessRestateDue). Whether
   *  there were any. Other CLIs' own compactions are not reported. */
  noteMemberCompactions(conversationId: string, participant: ChatParticipant): boolean {
    if (participant.kind !== "claude-code") return false;
    const take = (this.deps.cliRunner as { takeMemberClaudeCompactions?: (conversationId: string, participantId: string) => number }).takeMemberClaudeCompactions;
    const count = typeof take === "function" ? take.call(this.deps.cliRunner, conversationId, participant.id) : 0;
    if (count > 0) this.chat.memberSessions.accessRestateDue.add(memoryIndexKey(conversationId, participant.id));
    return count > 0;
  }

  participantDynamicHeader(
    conversation: Conversation,
    participant: ChatParticipant,
    session: ChatParticipantSession,
    options: { agentMode: ChatAgentMode; permissions: ChatAgentPermissions }
  ): string {
    const canRequestPermissions = this.chat.permissionRequests.canRequestPermissionChanges(session);
    if (isAdministratorSession(session)) {
      return [
        chatAssistantPermissionPolicy(participant.kind, options.agentMode, options.permissions, canRequestPermissions),
        ...compactionAccessLines(options.permissions),
        ...handleWritingLines(conversation)
      ].join("\n");
    }
    return [
      participantRepositoryLine(conversation, participant.kind, options.agentMode, options.permissions),
      participantPermissionPolicy(participant.kind, options.agentMode, options.permissions, canRequestPermissions),
      ...(participant.kind === "gemini-cli" ? antigravityAccessLines(conversation.repoPath, options.agentMode, options.permissions) : []),
      ...compactionAccessLines(options.permissions, isMainSessionParticipant(conversation.metadata, participant.id), participant.kind),
      ...scheduledTaskAccessLines(participant.kind, options.agentMode, options.permissions),
      ...handleWritingLines(conversation)
    ].filter(Boolean).join("\n");
  }

  /** What the member's turn on the User's message is told about its cards
   *  that message closed (the User, 2026-11-15): she wrote instead of
   *  choosing, so the card is no longer waiting above. */
  private closedChoicesPromptSection(conversation: Conversation, participant: ChatParticipant, triggerMessage: ChatMessage): string {
    const closedHere = this.chat.choiceExpiry.choiceClosedHere(conversation);
    // A card whose answer this device has heard of is closed by that answer,
    // never by her going on (sweepChoiceExpiry leaves it to the answer).
    const closed = choicesClosedByMessage(conversation.messages, participant.id, triggerMessage, (message) =>
      closedHere(message) && message.metadata?.serverCard?.state !== "answered" && !this.chat.choiceExpiry.choiceAnsweredHere(message.id));
    if (closed.length === 0) return "";
    return [
      closed.length === 1
        ? "Your earlier choice card was closed without an answer: User went on with her message below instead of picking one of its options."
        : "Your earlier choice cards were closed without an answer: User went on with her message below instead of picking one of their options.",
      ...closed.map((choice) => `- ${(choice.title || choice.question).replace(/\s+/g, " ").trim().slice(0, 200)}`),
      "Treat her message as User's answer or new direction. Do not say a card is waiting above; if you still need that decision, ask again."
    ].join("\n");
  }
}
