import { firstTextLine } from "../../../../shared/mainSessionView";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access as fileAccess, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { userDataPath } from "../../../platform";
import type { HubOp } from "../../../../shared/hubOps";
import { blobReferenceOf } from "../../hubClient";
import type {
  ChatImageAttachment, ChatImageInput, ChatImageMimeType, ChatMessage, ChatProviderKind, Conversation, ReadChatAttachmentRequest
} from "../../../../shared/types";
import { chatInterimPostAttachmentIds } from "../../../../shared/interimPosts";
import { normalizeChatAgentPermissions } from "../../../../shared/agentPermissions";
import { isDeviceEventBlobReference, type DeviceEventBlobReference } from "../../../../shared/deviceEventBlobs";
import type { CliAgentImageInput, CliAgentTurnImages } from "../../cliAgents";
import { APP_CHAT_READ_ATTACHMENT_TOOL } from "../../appMcp";
import { CHAT_IMAGE_EXTENSION_BY_MIME } from "./constants";
import { assertAttachmentExportTargetWritable, normalizeChatAttachmentExportRequest, resolveAttachmentExportTarget } from "./exportTargets";
import {
  chatAttachmentImportRoots, chatImageAttachmentForTool, chatImageDimensions, decodeImageInputBase64, detectChatImageMimeType,
  findImageAttachmentRecord, formatBytes, imageAttachments, normalizeChatImageFilename, normalizeChatImageMimeType,
  readFileWithMaxBytes, visibleImageAttachmentRecords
} from "./imageRecords";
import type { ChatAttachmentImportSource } from "./types";
import { isPathInside } from "../choices/mentions";
import { CHAT_IMAGE_MAX_ATTACHMENTS, CHAT_IMAGE_MAX_BYTES } from "../constants";
import { chatParticipants, messageAuthor } from "../members/identity";
import { appNotesBlock, newMessageNonce } from "../turns/promptSections";
import type { ChatAppMcpActor, ChatAttachmentImportSourceRoot, ChatToolImageAttachmentInput } from "../types";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

interface PreparedImageAttachments {
  attachments: ChatImageAttachment[];
  writtenPaths: string[];
}

interface PreparedToolImageAttachments extends PreparedImageAttachments {
  summaries: ChatToolImageAttachmentSummary[];
  totalBytes: number;
}

interface ChatToolImageAttachmentSummary {
  attachment: Omit<ChatImageAttachment, "storageKey">;
  sourceRoot: ChatAttachmentImportSourceRoot;
}

const CHAT_IMAGE_MAX_DIMENSION = 8192;
const CHAT_IMAGE_MAX_PIXELS = 25_000_000;

/** Pictures of a chat: taken in, stored, sent to members and to the User's server, exported. */
export class ChatAttachments {
  constructor(
    private readonly chat: Pick<ChatModules, "bodyTransport" | "store">,
    private readonly deps: Pick<ChatDependencies, "debugLogs">
  ) {}

  async readChatAttachment(request: ReadChatAttachmentRequest): Promise<{ attachment: ChatImageAttachment; dataBase64: string }> {
    await this.chat.store.waitForQueuedSave(request.conversationId);
    const conversation = await this.chat.store.requireChat(request.conversationId);
    const record = findImageAttachmentRecord(conversation, request.attachmentId);
    if (!record) {
      throw new Error("Attachment was not found in this conversation.");
    }
    const dataBase64 = await this.readAttachmentBase64(conversation.id, record.attachment);
    return {
      attachment: record.attachment,
      dataBase64
    };
  }

  async exportChatAttachmentForTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    await this.chat.store.waitForQueuedSave(actor.conversationId);
    const conversation = await this.chat.store.requireChat(actor.conversationId);
    const requester = chatParticipants(conversation).find((participant) => participant.id === actor.participantId);
    if (!requester) {
      throw new Error("The requesting member is no longer in this chat.");
    }
    const runPermissions = actor.runPermissions
      ? normalizeChatAgentPermissions(actor.runPermissions)
      : undefined;
    if (!runPermissions) {
      throw new Error(
        "AttachmentExportDenied. Problem: workspace write permission could not be verified for this member run. Cause: the app MCP token does not include a run-scoped permission snapshot. Fix: retry in a new member turn."
      );
    }
    if (!runPermissions.workspaceWrite) {
      throw new Error(
        "AttachmentExportDenied. Problem: workspaceWrite is not granted for this member run. Cause: exporting an attachment writes a file into the selected repository. Fix: request workspaceWrite permission, then retry the export."
      );
    }
    const request = normalizeChatAttachmentExportRequest(rawRequest);
    const record = visibleImageAttachmentRecords(conversation, actor).find((item) => item.attachment.id === request.attachmentId);
    if (!record) {
      void this.deps.debugLogs.write("chat.attachments.mcp-export-denied", {
        conversationId: actor.conversationId,
        participantId: actor.participantId,
        attachmentId: request.attachmentId,
        snapshotMaxSequence: actor.snapshotMaxSequence
      });
      throw new Error(
        "AttachmentExportDenied. Problem: this attachment is not visible to the current member turn. Cause: the attachment id is absent, belongs to another conversation, or is newer than this turn snapshot. Fix: call app_chat_list_attachments for visible attachment IDs, or ask User to resend the image."
      );
    }

    const target = await resolveAttachmentExportTarget(conversation, record.attachment, request);
    const sizeBytes = await this.copyAttachmentToExportTarget(conversation.id, record.attachment, target.absolutePath, request.overwrite);
    return {
      conversationId: conversation.id,
      requesterParticipantId: requester.id,
      messageId: record.message.id,
      sequence: record.sequence,
      author: messageAuthor(record.message),
      threadId: record.message.metadata?.threadId,
      attachment: chatImageAttachmentForTool(record.attachment),
      targetPath: target.relativePath,
      sizeBytes,
      overwrite: request.overwrite
    };
  }

  /**
   * The pictures of the message a turn answers, for the CLI's own image
   * input (Claude Code's stream-json image blocks, which Claude Code 2.1.330
   * downsizes itself as its terminal does; Codex's `localImage`), as a
   * picture pasted into the dedicated CLI goes. A picture made on another
   * device is fetched first (readAttachmentBase64). Antigravity takes no
   * pictures: they are named for the attachment tools instead
   * (picturesNote), as is done by a Claude transport without image input
   * (fallbackText). A picture that cannot be loaded is said in words.
   * `cleanup` removes the temporary copies made for Codex, once the turn
   * has ended.
   */
  async turnImagesForCli(
    conversationId: string,
    message: ChatMessage,
    providerKind: ChatProviderKind,
    /** The message's nonce: the words a transport without image input adds
     *  after the message go in an APP block (buildPromptParts). */
    nonce: string = newMessageNonce()
  ): Promise<{ images?: CliAgentTurnImages; picturesNote?: string; unavailableNote?: string; cleanup: () => Promise<void> }> {
    const attachments = imageAttachments(message);
    const noCleanup = async (): Promise<void> => undefined;
    if (attachments.length === 0) {
      return { cleanup: noCleanup };
    }
    const named = (list: ChatImageAttachment[]): string => [
      `Attached pictures (look at them with \`${APP_CHAT_READ_ATTACHMENT_TOOL}\`):`,
      ...list.map((attachment) => `- ${attachment.filename} (${attachment.mimeType}, ${attachment.width}x${attachment.height}, attachment ID ${attachment.id})`)
    ].join("\n");
    if (providerKind === "gemini-cli") {
      return { picturesNote: named(attachments), cleanup: noCleanup };
    }
    const items: CliAgentImageInput[] = [];
    const loaded: ChatImageAttachment[] = [];
    const unavailable: string[] = [];
    let temporaryDirectory: string | undefined;
    for (const attachment of attachments) {
      try {
        const dataBase64 = await this.readAttachmentBase64(conversationId, attachment);
        const stored = this.attachmentPath(conversationId, attachment.storageKey);
        let file = stored;
        // Codex reads `localImage` from disk: a picture whose stored copy
        // could not be kept goes from a private temporary folder.
        if (!await fileAccess(stored).then(() => true, () => false)) {
          temporaryDirectory ??= await mkdtemp(path.join(tmpdir(), "accordagents-turn-images-"));
          file = path.join(temporaryDirectory, path.basename(stored));
          await writeFile(file, Buffer.from(dataBase64, "base64"), { mode: 0o600, flag: "wx" });
        }
        items.push({ mimeType: attachment.mimeType, dataBase64, path: file });
        loaded.push(attachment);
      } catch (error) {
        unavailable.push(`- ${attachment.filename} (attachment ID ${attachment.id}): ${firstTextLine(error instanceof Error ? error.message : String(error), 300)}`);
      }
    }
    const directory = temporaryDirectory;
    return {
      ...(items.length > 0 ? { images: { items, fallbackText: appNotesBlock(nonce, [named(loaded)]) } } : {}),
      ...(unavailable.length > 0 ? { unavailableNote: ["A picture attached to this message did not come with it:", ...unavailable].join("\n") } : {}),
      cleanup: directory ? () => rm(directory, { recursive: true, force: true }).catch(() => undefined) : noCleanup
    };
  }

  /** turnImagesForCli for a turn that took waiting messages in
   *  (TurnQueue.joinWaitingTurns): the pictures of each, in their order. */
  async turnImagesForMessages(
    conversationId: string,
    messages: readonly ChatMessage[],
    providerKind: ChatProviderKind,
    nonce: string = newMessageNonce()
  ): Promise<{ images?: CliAgentTurnImages; picturesNote?: string; unavailableNote?: string; cleanup: () => Promise<void> }> {
    const parts = await Promise.all(messages.map((message) => this.turnImagesForCli(conversationId, message, providerKind, nonce)));
    if (parts.length === 1) return parts[0]!;
    const items = parts.flatMap((part) => part.images?.items ?? []);
    const join = (texts: Array<string | undefined>): string | undefined => texts.filter(Boolean).join("\n\n") || undefined;
    const fallbackText = join(parts.map((part) => part.images?.fallbackText));
    const picturesNote = join(parts.map((part) => part.picturesNote));
    const unavailableNote = join(parts.map((part) => part.unavailableNote));
    return {
      ...(items.length > 0 ? { images: { items, fallbackText: fallbackText ?? "" } } : {}),
      ...(picturesNote ? { picturesNote } : {}),
      ...(unavailableNote ? { unavailableNote } : {}),
      cleanup: async () => { await Promise.all(parts.map((part) => part.cleanup())); }
    };
  }

  private async copyAttachmentToExportTarget(
    conversationId: string,
    attachment: ChatImageAttachment,
    absolutePath: string,
    overwrite: boolean
  ): Promise<number> {
    const sourcePath = this.attachmentPath(conversationId, attachment.storageKey);
    let sourceInfo: Awaited<ReturnType<typeof stat>>;
    try {
      sourceInfo = await stat(sourcePath);
      if (!sourceInfo.isFile()) {
        throw new Error("source is not a regular file");
      }
    } catch (error) {
      void this.deps.debugLogs.write("chat.attachments.missing", {
        conversationId,
        attachmentId: attachment.id,
        message: error instanceof Error ? error.message : String(error)
      });
      throw new Error(
        "AttachmentMissing. Problem: the attachment metadata exists, but the image file could not be read. Cause: the attachment file is missing or inaccessible in app storage. Fix: ask User to resend the image."
      );
    }

    if (!overwrite) {
      try {
        await copyFile(sourcePath, absolutePath, fsConstants.COPYFILE_EXCL);
        return sourceInfo.size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(
            "AttachmentExportDenied. Problem: targetPath already exists. Cause: another file appeared at the destination before export completed. Fix: choose a different targetPath or retry with overwrite set to true."
          );
        }
        throw new Error(
          `AttachmentExportFailed. Problem: the attachment could not be exported. Cause: ${error instanceof Error ? error.message : String(error)}. Fix: check repository file permissions and retry.`
        );
      }
    }

    const tempPath = `${absolutePath}.${randomUUID()}.tmp`;
    try {
      await copyFile(sourcePath, tempPath);
      await assertAttachmentExportTargetWritable(absolutePath, path.basename(absolutePath), true);
      await rename(tempPath, absolutePath);
      return sourceInfo.size;
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw new Error(
        `AttachmentExportFailed. Problem: the attachment could not be exported. Cause: ${error instanceof Error ? error.message : String(error)}. Fix: check repository file permissions and retry.`
      );
    }
  }

  async readAttachmentBase64(conversationId: string, attachment: ChatImageAttachment): Promise<string> {
    const filePath = this.attachmentPath(conversationId, attachment.storageKey);
    let bytes: Buffer;
    try {
      bytes = await readFile(filePath);
    } catch (error) {
      // A picture made on another device (the phone, the computer, a cloud
      // machine) is not on this one's disk: its device put it on the User's
      // server, and a machine may also ask the desktop for an older one.
      // What comes back is kept, so the next read is local.
      let ownerRefusal: string | undefined;
      const fetched = await this.fetchAttachmentFromOwner(conversationId, attachment).catch((fetchError) => {
        ownerRefusal = fetchError instanceof Error ? fetchError.message : String(fetchError);
        void this.deps.debugLogs.write("chat.attachments.fetch-failed", {
          conversationId,
          attachmentId: attachment.id,
          message: ownerRefusal
        });
        return undefined;
      });
      if (fetched) {
        return fetched;
      }
      if (ownerRefusal) {
        // The server or the desktop was asked and could not give it: the
        // picture is not lost, so a resend would not help. Say what happened.
        throw new Error(
          `AttachmentUnavailable. Problem: the image was made on another device, and it could not be fetched from the User's server or the desktop that owns this chat. Cause: ${ownerRefusal} Fix: tell User the picture could not be fetched right now; do not ask for a resend.`
        );
      }
      void this.deps.debugLogs.write("chat.attachments.missing", {
        conversationId,
        attachmentId: attachment.id,
        message: error instanceof Error ? error.message : String(error)
      });
      throw new Error(
        "AttachmentMissing. Problem: the attachment metadata exists, but the image file could not be read. Cause: the attachment file is missing or inaccessible in app storage. Fix: ask User to resend the image."
      );
    }
    return bytes.toString("base64");
  }

  /** The picture's bytes from the User's server (or, on a machine, from the
   *  desktop that owns the chat), written to this device's own store so one
   *  fetch serves every later read. A picture named nowhere it can be read
   *  from is reported missing. */
  private async fetchAttachmentFromOwner(conversationId: string, attachment: ChatImageAttachment): Promise<string | undefined> {
    // A picture is on the User's server, named by its body, when the device
    // that made it put it there (the phone always; the computer and the
    // machines since they do): every device reads it from there.
    const hubBlob = attachment.hubBlob;
    // A server that cannot answer now leaves the machine link to try.
    let hubError: string | undefined;
    const fromHub = this.chat.bodyTransport.hubBlobReader && isDeviceEventBlobReference(hubBlob)
      ? await this.chat.bodyTransport.hubBlobReader(hubBlob).then((bytes) => bytes.toString("base64"), (error: unknown) => {
        hubError = error instanceof Error ? error.message : String(error);
        void this.deps.debugLogs.write("chat.attachment.hub-read-error", { conversationId, attachmentId: attachment.id, message: hubError });
        return undefined;
      })
      : undefined;
    const fetch = this.chat.bodyTransport.machineLink?.fetchAttachment;
    if (!fromHub && !fetch) {
      // The server holds it and could not give it now: unavailable, not lost.
      if (hubError) throw new Error(`Your server could not give the picture: ${hubError}`);
      return undefined;
    }
    const result = fromHub ? { dataBase64: fromHub } : await fetch!.call(this.chat.bodyTransport.machineLink, conversationId, attachment.id);
    const dataBase64 = typeof result?.dataBase64 === "string" ? result.dataBase64 : "";
    if (!dataBase64) {
      return undefined;
    }
    const filePath = this.attachmentPath(conversationId, attachment.storageKey);
    // Written beside its final name and renamed into place, so a parallel read
    // (a member issues tool calls concurrently) never sees a half-written file.
    const partialPath = `${filePath}.${randomUUID()}.part`;
    await mkdir(path.dirname(filePath), { recursive: true }).catch(() => undefined);
    await writeFile(partialPath, Buffer.from(dataBase64, "base64"), { mode: 0o600 })
      .then(() => rename(partialPath, filePath))
      .catch(async (error) => {
        // Not fatal: the member gets its picture even when this machine cannot
        // keep a copy, it just pays for the fetch again next time.
        await rm(partialPath, { force: true }).catch(() => undefined);
        void this.deps.debugLogs.write("chat.attachments.cache-failed", {
          conversationId,
          attachmentId: attachment.id,
          message: error instanceof Error ? error.message : String(error)
        });
      });
    return dataBase64;
  }

  async prepareImageAttachments(conversationId: string, inputs: ChatImageInput[] | undefined): Promise<PreparedImageAttachments> {
    if (!inputs || inputs.length === 0) {
      return { attachments: [], writtenPaths: [] };
    }
    if (!Array.isArray(inputs)) {
      throw new Error("Image attachments must be an array.");
    }
    if (inputs.length > CHAT_IMAGE_MAX_ATTACHMENTS) {
      throw new Error(`Too many images. Attach at most ${CHAT_IMAGE_MAX_ATTACHMENTS} images per message.`);
    }

    const prepared: PreparedImageAttachments = { attachments: [], writtenPaths: [] };
    try {
      for (let index = 0; index < inputs.length; index += 1) {
        const persisted = await this.prepareImageAttachment(conversationId, inputs[index], index);
        prepared.attachments.push(persisted.attachment);
        prepared.writtenPaths.push(persisted.filePath);
      }
      return prepared;
    } catch (error) {
      await this.rollbackPreparedImageAttachments(conversationId, prepared, "AttachmentPersistFailed", error);
      throw error;
    }
  }

  private async prepareImageAttachment(
    conversationId: string,
    input: ChatImageInput,
    index: number
  ): Promise<{ attachment: ChatImageAttachment; filePath: string }> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Image attachment input is invalid.");
    }
    const mimeType = normalizeChatImageMimeType(input.mimeType);
    const bytes = decodeImageInputBase64(input.dataBase64);
    return this.persistChatImageAttachment(conversationId, {
      bytes,
      filename: input.filename,
      mimeType,
      providedMimeType: input.mimeType
    }, index);
  }

  async prepareToolImageAttachments(
    conversation: Conversation,
    actor: ChatAppMcpActor,
    inputs: ChatToolImageAttachmentInput[]
  ): Promise<PreparedToolImageAttachments> {
    if (inputs.length === 0) {
      return { attachments: [], writtenPaths: [], summaries: [], totalBytes: 0 };
    }
    const prepared: PreparedToolImageAttachments = { attachments: [], writtenPaths: [], summaries: [], totalBytes: 0 };
    try {
      for (let index = 0; index < inputs.length; index += 1) {
        const input = inputs[index];
        const source = await this.resolveChatAttachmentImportSource(conversation, actor, input.sourcePath);
        const bytes = await readFileWithMaxBytes(source, CHAT_IMAGE_MAX_BYTES);
        const persisted = await this.persistChatImageAttachment(conversation.id, {
          bytes,
          filename: input.filename ?? path.basename(source.realPath),
          mimeType: input.mimeType,
          providedMimeType: input.mimeType
        }, index);
        prepared.attachments.push(persisted.attachment);
        prepared.writtenPaths.push(persisted.filePath);
        prepared.totalBytes += persisted.attachment.sizeBytes;
        prepared.summaries.push({
          attachment: chatImageAttachmentForTool(persisted.attachment),
          sourceRoot: source.root
        });
      }
      return prepared;
    } catch (error) {
      await this.rollbackPreparedImageAttachments(conversation.id, prepared, "AttachmentImportFailed", error);
      throw error;
    }
  }

  private async persistChatImageAttachment(
    conversationId: string,
    input: {
      bytes: Buffer;
      filename?: string;
      mimeType?: ChatImageMimeType;
      providedMimeType?: string;
    },
    index: number
  ): Promise<{ attachment: ChatImageAttachment; filePath: string }> {
    const bytes = input.bytes;
    if (bytes.length === 0) {
      throw new Error("ImageDecodeFailed. Problem: image data is empty. Cause: the pasted or selected image did not produce bytes. Fix: paste or choose the image again.");
    }
    if (bytes.length > CHAT_IMAGE_MAX_BYTES) {
      throw new Error(`ImageTooLarge. Problem: image ${index + 1} is ${formatBytes(bytes.length)}. Cause: v1 accepts images up to ${formatBytes(CHAT_IMAGE_MAX_BYTES)}. Fix: crop or compress the image and try again.`);
    }
    const detectedMimeType = detectChatImageMimeType(bytes);
    if (!detectedMimeType || (input.mimeType && detectedMimeType !== input.mimeType)) {
      void this.deps.debugLogs.write("chat.attachments.validation-failed", {
        conversationId,
        reason: "mime-mismatch",
        providedMimeType: input.providedMimeType,
        detectedMimeType
      });
      throw new Error("UnsupportedImageType. Problem: image MIME type does not match the file bytes. Cause: the attachment is not a PNG, JPEG, or WebP image. Fix: paste or choose a PNG, JPEG, or WebP image.");
    }
    const mimeType = detectedMimeType;
    const dimensions = chatImageDimensions(bytes, mimeType);
    if (!dimensions) {
      void this.deps.debugLogs.write("chat.attachments.validation-failed", {
        conversationId,
        reason: "dimensions-unreadable",
        mimeType
      });
      throw new Error("ImageDecodeFailed. Problem: image dimensions could not be read. Cause: the image is malformed or uses an unsupported encoding. Fix: export it as PNG, JPEG, or WebP and try again.");
    }
    if (
      dimensions.width > CHAT_IMAGE_MAX_DIMENSION ||
      dimensions.height > CHAT_IMAGE_MAX_DIMENSION ||
      dimensions.width * dimensions.height > CHAT_IMAGE_MAX_PIXELS
    ) {
      throw new Error(`ImageTooManyPixels. Problem: image is ${dimensions.width}x${dimensions.height}. Cause: v1 accepts images up to ${CHAT_IMAGE_MAX_DIMENSION}px per side and ${CHAT_IMAGE_MAX_PIXELS.toLocaleString()} pixels. Fix: crop or scale the image and try again.`);
    }

    const attachmentId = randomUUID();
    const extension = CHAT_IMAGE_EXTENSION_BY_MIME[mimeType];
    const storageKey = `attachments/${attachmentId}.${extension}`;
    const filePath = this.attachmentPath(conversationId, storageKey);
    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    await mkdir(path.dirname(filePath), { recursive: true });
    try {
      await writeFile(tempPath, bytes);
      await rename(tempPath, filePath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      void this.deps.debugLogs.write("chat.attachments.persistence-failed", {
        conversationId,
        attachmentId,
        message: error instanceof Error ? error.message : String(error)
      });
      throw new Error("AttachmentPersistFailed. Problem: the image could not be saved. Cause: app attachment storage is unavailable or full. Fix: retry, or check local disk permissions and free space.");
    }

    return {
      filePath,
      attachment: {
        id: attachmentId,
        filename: normalizeChatImageFilename(input.filename, extension, index),
        mimeType,
        sizeBytes: bytes.length,
        width: dimensions.width,
        height: dimensions.height,
        storageKey,
        createdAt: new Date().toISOString(),
        // Named by its content now; the bytes go up to the User's server
        // right before the message that names them (putServerPictures).
        hubBlob: blobReferenceOf(bytes)
      }
    };
  }

  /**
   * Puts on the User's server the pictures these operations name that this
   * device holds, before the operations go: the phone does the same, and
   * every other device (the computer, a machine, the phone) reads a picture
   * from there. A picture is in a message from the message's creation (a
   * later update names the same one), and a chat moving to a server carries
   * its messages whole. A failed put throws, so the operations wait and are
   * tried again with it: a message never reaches the server ahead of its
   * picture.
   */
  async putServerPictures(
    ops: readonly HubOp[],
    put: (reference: DeviceEventBlobReference, bytes: Buffer) => Promise<void>,
    alreadyPut: (blobHash: string) => boolean
  ): Promise<void> {
    for (const op of ops) {
      const messages = op.kind === "message.create" || op.kind === "message.update" ? [op.message] : op.kind === "chat.import" ? op.messages : [];
      for (const message of messages) {
        const attachments = message.metadata?.imageAttachments;
        if (!Array.isArray(attachments)) continue;
        // An update brings only the pictures of posts made into a running
        // reply during its turn (interimPosts.ts); a message's own pictures
        // went up with it when it was written.
        const posted = op.kind === "message.update" ? chatInterimPostAttachmentIds(message) : undefined;
        for (const attachment of attachments) {
          if (posted && !posted.has(attachment?.id)) continue;
          const reference = attachment?.hubBlob;
          if (!isDeviceEventBlobReference(reference) || alreadyPut(reference.blobHash) || typeof attachment.storageKey !== "string") continue;
          let bytes: Buffer;
          try {
            bytes = await readFile(this.attachmentPath(op.conversationId, attachment.storageKey));
          } catch (error) {
            // Not on this device (a picture the phone or a machine made, in
            // a chat moving to a server): its own device put it there. Kept
            // in the log, as a picture this device made and lost would be.
            void this.deps.debugLogs.write("chat.attachments.server-put-missing", {
              conversationId: op.conversationId, attachmentId: attachment.id,
              message: error instanceof Error ? error.message : String(error)
            });
            continue;
          }
          const held = blobReferenceOf(bytes);
          if (held.blobHash !== reference.blobHash || held.byteLength !== reference.byteLength) {
            // This device's file is not the picture the message names (a
            // copy cached from elsewhere and changed since): nothing to put.
            void this.deps.debugLogs.write("chat.attachments.server-put-mismatch", {
              conversationId: op.conversationId, attachmentId: attachment.id
            });
            continue;
          }
          await put(reference, bytes);
        }
      }
    }
  }

  private async resolveChatAttachmentImportSource(
    conversation: Conversation,
    actor: ChatAppMcpActor,
    sourcePath: string
  ): Promise<ChatAttachmentImportSource> {
    const runPermissions = actor.runPermissions
      ? normalizeChatAgentPermissions(actor.runPermissions)
      : undefined;
    if (!runPermissions) {
      throw new Error(
        "AttachmentImportDenied. Problem: sourcePath import permission could not be verified for this member run. Cause: the app MCP token does not include a run-scoped permission snapshot. Fix: retry in a new member turn."
      );
    }
    const allowedRoots = await chatAttachmentImportRoots(conversation, runPermissions);
    if (allowedRoots.length === 0) {
      throw new Error(
        "AttachmentImportDenied. Problem: this member run has no allowed image import roots. Cause: sourcePath imports require repoRead for selected-repository files. Fix: request repoRead or attach image content another way."
      );
    }

    const candidatePath = path.isAbsolute(sourcePath)
      ? path.resolve(sourcePath)
      : conversation.repoPath && runPermissions.repoRead
        ? path.resolve(conversation.repoPath, sourcePath)
        : undefined;
    if (!candidatePath) {
      throw new Error(
        "AttachmentImportDenied. Problem: relative sourcePath cannot be resolved. Cause: relative imports require repoRead and a selected repository. Fix: pass a repository-relative path in a repo-enabled chat."
      );
    }
    const normalizedCandidatePath = path.resolve(candidatePath);
    const lexicalRoot = allowedRoots.find((root) =>
      isPathInside(root.rootPath, normalizedCandidatePath) ||
      isPathInside(root.realPath, normalizedCandidatePath)
    );
    if (!lexicalRoot) {
      void this.deps.debugLogs.write("chat.attachments.import-denied", {
        conversationId: conversation.id,
        participantId: actor.participantId,
        reason: "outside-allowed-roots"
      });
      throw new Error(
        "AttachmentImportDenied. Problem: sourcePath is outside allowed roots for this run. Cause: sourcePath imports are limited to the selected repository when repoRead is granted. Fix: use an image file path inside the selected repository."
      );
    }

    let linkInfo: Awaited<ReturnType<typeof lstat>>;
    try {
      linkInfo = await lstat(normalizedCandidatePath);
    } catch (error) {
      throw new Error(
        `AttachmentImportDenied. Problem: sourcePath could not be inspected. Cause: ${error instanceof Error ? error.message : String(error)}. Fix: pass an existing image file path visible to this run.`
      );
    }
    if (linkInfo.isSymbolicLink()) {
      throw new Error(
        "AttachmentImportDenied. Problem: sourcePath points to a symlink. Cause: importing through symlinks could escape allowed roots. Fix: pass the real image file path inside an allowed root."
      );
    }
    if (linkInfo.isDirectory()) {
      throw new Error(
        "AttachmentImportDenied. Problem: sourcePath points to a directory. Cause: image attachments require a file path. Fix: pass a PNG, JPEG, or WebP file."
      );
    }
    if (!linkInfo.isFile()) {
      throw new Error(
        "AttachmentImportDenied. Problem: sourcePath is not a regular file. Cause: app_chat_send_message can import regular image files only. Fix: pass a PNG, JPEG, or WebP file."
      );
    }
    if (linkInfo.size > CHAT_IMAGE_MAX_BYTES) {
      throw new Error(`ImageTooLarge. Problem: sourcePath is ${formatBytes(linkInfo.size)}. Cause: v1 accepts images up to ${formatBytes(CHAT_IMAGE_MAX_BYTES)}. Fix: crop or compress the image and try again.`);
    }

    let realFilePath: string;
    try {
      realFilePath = await realpath(normalizedCandidatePath);
    } catch (error) {
      throw new Error(
        `AttachmentImportDenied. Problem: sourcePath could not be resolved. Cause: ${error instanceof Error ? error.message : String(error)}. Fix: pass an existing image file path visible to this run.`
      );
    }
    const allowedRoot = allowedRoots.find((root) => isPathInside(root.realPath, realFilePath));
    if (!allowedRoot) {
      void this.deps.debugLogs.write("chat.attachments.import-denied", {
        conversationId: conversation.id,
        participantId: actor.participantId,
        reason: "outside-allowed-roots"
      });
      throw new Error(
        "AttachmentImportDenied. Problem: sourcePath is outside allowed roots for this run. Cause: sourcePath imports are limited to the selected repository when repoRead is granted. Fix: use an image file path inside the selected repository."
      );
    }
    const fileInfo = await stat(realFilePath);
    if (!fileInfo.isFile()) {
      throw new Error(
        "AttachmentImportDenied. Problem: sourcePath is not a regular file after resolution. Cause: app_chat_send_message can import regular image files only. Fix: pass a PNG, JPEG, or WebP file."
      );
    }
    if (fileInfo.size > CHAT_IMAGE_MAX_BYTES) {
      throw new Error(`ImageTooLarge. Problem: sourcePath is ${formatBytes(fileInfo.size)}. Cause: v1 accepts images up to ${formatBytes(CHAT_IMAGE_MAX_BYTES)}. Fix: crop or compress the image and try again.`);
    }
    return { realPath: realFilePath, root: allowedRoot.root, dev: fileInfo.dev, ino: fileInfo.ino };
  }

  async rollbackPreparedImageAttachments(
    conversationId: string,
    prepared: PreparedImageAttachments,
    reason: string,
    cause: unknown
  ): Promise<void> {
    if (prepared.writtenPaths.length === 0) {
      return;
    }
    await Promise.all(prepared.writtenPaths.map((filePath) => rm(filePath, { force: true }).catch(() => undefined)));
    void this.deps.debugLogs.write("chat.attachments.rollback", {
      conversationId,
      reason,
      attachmentIds: prepared.attachments.map((attachment) => attachment.id),
      message: cause instanceof Error ? cause.message : String(cause)
    });
  }

  private attachmentPath(conversationId: string, storageKey: string): string {
    if (!/^attachments\/[A-Za-z0-9-]+\.(?:png|jpg|webp)$/.test(storageKey)) {
      throw new Error("Attachment storage key is invalid.");
    }
    return path.join(userDataPath(), "chats", conversationId, storageKey);
  }
}
