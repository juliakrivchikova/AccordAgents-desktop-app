/**
 * App tool wiring shared by the desktop main process and the headless machine
 * runtime (machines transport, work item 2). Every machine serves the full App
 * MCP tool registry from its own copy, so the handler set must be identical
 * wherever ChatService and ArtifactService run.
 */

import type {
  ArtifactDraftAudiencePolicyByAuthor,
  PublishArtifactSourceRequest
} from "../shared/types";
import type { ArtifactService } from "./services/artifacts";
import { validateArtifactCreateToolRequest } from "./services/artifactToolRequest";
import type { ChatService } from "./services/chat";
import {
  APP_ARTIFACT_CREATE_TOOL,
  APP_ARTIFACT_DRAFT_LIST_TOOL,
  APP_ARTIFACT_DRAFT_READ_TOOL,
  APP_ARTIFACT_DRAFT_REPLACE_TOOL,
  APP_ARTIFACT_DRAFT_SAVE_TOOL,
  APP_ARTIFACT_DRAFT_SET_ROSTER_TOOL,
  APP_ARTIFACT_DRAFT_SUBMIT_TOOL,
  APP_ARTIFACT_DRAFT_WITHDRAW_TOOL,
  APP_ARTIFACT_DIFF_TOOL,
  APP_ARTIFACT_LIST_TOOL,
  APP_ARTIFACT_PUBLISH_TOOL,
  APP_ARTIFACT_READ_TOOL,
  APP_ARTIFACT_RENAME_TOOL,
  APP_ARTIFACT_REVISE_TOOL,
  APP_ARTIFACT_SET_ARCHIVED_TOOL,
  APP_ARTIFACT_SET_ACCESS_TOOL,
  APP_ARTIFACT_SIGN_TOOL,
  type AppMcpService
} from "./services/appMcp";

export type ArtifactToolDispatcher = (
  member: string,
  conversationId: string,
  toolName: string,
  rawRequest: unknown
) => Promise<unknown>;

/** Registers every chat-facing app tool handler on the App MCP service. */
export function wireChatAppToolHandlers(appMcpService: AppMcpService, chatService: ChatService): void {
  appMcpService.setRosterChangeHandler((actor, request) => chatService.requestRosterChangeFromTool(actor, request));
  appMcpService.setRosterOptionsHandler((actor) => chatService.describeRosterOptionsForTool(actor));
  appMcpService.setRoleChangeHandler((actor, request) => chatService.requestRoleChangeFromTool(actor, request));
  appMcpService.setRoleOptionsHandler((actor) => chatService.describeRoleOptionsForTool(actor));
  appMcpService.setParticipantChangeHandler((actor, request) => chatService.requestParticipantChangeFromTool(actor, request));
  appMcpService.setParticipantOptionsHandler((actor) => chatService.describeParticipantOptionsForTool(actor));
  appMcpService.setPermissionChangeHandler((actor, request) => chatService.requestPermissionChangeFromTool(actor, request));
  appMcpService.setToolPermissionHandler((actor, request) => chatService.requestToolPermissionFromTool(actor, request));
  appMcpService.setChatContextHandler((actor) => chatService.describeChatContextForTool(actor));
  appMcpService.setChatParticipantsHandler((actor) => chatService.describeChatParticipantsForTool(actor));
  appMcpService.setChatParticipantActivityHandler((actor) => chatService.describeChatParticipantActivityForTool(actor));
  appMcpService.setChatMessagesHandler((actor, request) => chatService.readChatMessagesForTool(actor, request));
  appMcpService.setChatAttachmentListHandler((actor, request) => chatService.listChatAttachmentsForTool(actor, request));
  appMcpService.setChatAttachmentReadHandler((actor, request) => chatService.readChatAttachmentForTool(actor, request));
  appMcpService.setChatAttachmentExportHandler((actor, request) => chatService.exportChatAttachmentForTool(actor, request));
  appMcpService.setChatParticipantRequestHandler((actor, request) => chatService.requestParticipantsFromTool(actor, request));
  appMcpService.setChatCompactionRequestHandler((actor, request) => chatService.requestSelfCompactionFromTool(actor, request));
  appMcpService.setChatParticipantRequestStatusHandler((actor, request) => chatService.participantRequestStatusForTool(actor, request));
  appMcpService.setChatReactHandler((actor, request) => chatService.reactToMessageFromTool(actor, request));
  appMcpService.setChatSendMessageHandler((actor, request) => chatService.sendChatMessageFromTool(actor, request));
  appMcpService.setChatSetTitleHandler((actor, request) => chatService.setChatTitleFromTool(actor, request));
}

/** Registers the artifact tool handler: resolves the acting member through the
 *  chat service, then dispatches to the artifact service. */
export function wireArtifactToolHandler(
  appMcpService: AppMcpService,
  chatService: ChatService,
  dispatch: ArtifactToolDispatcher
): void {
  appMcpService.setArtifactToolHandler(async (actor, toolName, request) => {
    let member: string;
    try {
      member = await chatService.artifactActorMember(actor);
    } catch (error) {
      return {
        ok: false,
        error: { code: "access_denied", message: error instanceof Error ? error.message : String(error) }
      };
    }
    return dispatch(member, actor.conversationId, toolName, request);
  });
}

export function createArtifactToolDispatcher(artifactService: ArtifactService): ArtifactToolDispatcher {
  return async (member, conversationId, toolName, rawRequest) => {
    const args = rawRequest && typeof rawRequest === "object" && !Array.isArray(rawRequest)
      ? rawRequest as Record<string, unknown>
      : {};
    const ref = {
      artifactId: artifactToolString(args.artifactId),
      name: artifactToolString(args.name)
    };
    switch (toolName) {
      case APP_ARTIFACT_LIST_TOOL:
        return artifactService.list(member, conversationId);
      case APP_ARTIFACT_READ_TOOL:
        return artifactService.read(member, {
          conversationId,
          ...ref,
          version: artifactToolOptionalNumber(args.version),
          includeHistory: args.includeHistory === true
        });
      case APP_ARTIFACT_DIFF_TOOL:
        return artifactService.diff(member, {
          conversationId,
          ...ref,
          fromVersion: artifactToolNumber(args.fromVersion),
          toVersion: artifactToolNumber(args.toVersion)
        });
      case APP_ARTIFACT_CREATE_TOOL: {
        const validationError = validateArtifactCreateToolRequest(args);
        if (validationError) {
          return { ok: false, error: { code: "invalid_request", message: validationError } };
        }
        return artifactService.create(member, args.initialState === "collecting_drafts" ? {
          conversationId,
          name: typeof args.name === "string" ? args.name : "",
          initialState: "collecting_drafts",
          contributors: artifactToolStringArray(args.contributors),
          labels: artifactToolStringArray(args.labels),
          allowedDraftAuthors: artifactToolStringArray(args.allowedDraftAuthors) ?? [],
          requiredDraftAuthors: artifactToolStringArray(args.requiredDraftAuthors) ?? [],
          audiencePolicyByAuthor: artifactToolAudiencePolicy(args.audiencePolicyByAuthor),
          operationId: typeof args.operationId === "string" ? args.operationId : ""
        } : {
          conversationId,
          name: typeof args.name === "string" ? args.name : "",
          initialState: "published",
          content: typeof args.content === "string" ? args.content : "",
          note: artifactToolString(args.note),
          contributors: artifactToolStringArray(args.contributors),
          requiredSigners: artifactToolStringArray(args.requiredSigners),
          labels: artifactToolStringArray(args.labels)
        });
      }
      case APP_ARTIFACT_DRAFT_LIST_TOOL:
        return artifactService.listDrafts(member, { conversationId, ...ref });
      case APP_ARTIFACT_DRAFT_READ_TOOL:
        return artifactService.readDraft(member, {
          conversationId,
          ...ref,
          draftId: typeof args.draftId === "string" ? args.draftId : ""
        });
      case APP_ARTIFACT_DRAFT_SAVE_TOOL:
        return artifactService.saveDraft(member, {
          conversationId,
          ...ref,
          draftId: artifactToolString(args.draftId),
          expectedEditRevision: artifactToolNumber(args.expectedEditRevision),
          content: typeof args.content === "string" ? args.content : "",
          readers: artifactToolStringArray(args.readers) ?? [],
          operationId: typeof args.operationId === "string" ? args.operationId : ""
        });
      case APP_ARTIFACT_DRAFT_SUBMIT_TOOL:
        return artifactService.submitDraft(member, {
          conversationId,
          ...ref,
          draftId: typeof args.draftId === "string" ? args.draftId : "",
          expectedEditRevision: artifactToolNumber(args.expectedEditRevision),
          operationId: typeof args.operationId === "string" ? args.operationId : ""
        });
      case APP_ARTIFACT_DRAFT_REPLACE_TOOL:
        return artifactService.replaceDraft(member, {
          conversationId,
          ...ref,
          supersedesDraftId: typeof args.supersedesDraftId === "string" ? args.supersedesDraftId : "",
          content: typeof args.content === "string" ? args.content : "",
          readers: artifactToolStringArray(args.readers) ?? [],
          operationId: typeof args.operationId === "string" ? args.operationId : ""
        });
      case APP_ARTIFACT_DRAFT_WITHDRAW_TOOL:
        return artifactService.withdrawDraft(member, {
          conversationId,
          ...ref,
          draftId: typeof args.draftId === "string" ? args.draftId : "",
          operationId: typeof args.operationId === "string" ? args.operationId : ""
        });
      case APP_ARTIFACT_DRAFT_SET_ROSTER_TOOL:
        return artifactService.updateDraftRoster(member, {
          conversationId,
          ...ref,
          allowedDraftAuthors: artifactToolStringArray(args.allowedDraftAuthors) ?? [],
          requiredDraftAuthors: artifactToolStringArray(args.requiredDraftAuthors) ?? [],
          audiencePolicyByAuthor: artifactToolAudiencePolicy(args.audiencePolicyByAuthor),
          expectedDraftRosterRevision: artifactToolNumber(args.expectedDraftRosterRevision),
          operationId: typeof args.operationId === "string" ? args.operationId : ""
        });
      case APP_ARTIFACT_PUBLISH_TOOL:
        return artifactService.publish(member, {
          conversationId,
          ...ref,
          content: typeof args.content === "string" ? args.content : "",
          note: artifactToolString(args.note),
          requiredSigners: artifactToolStringArray(args.requiredSigners) ?? [],
          sources: artifactToolSources(args.sources),
          operationId: typeof args.operationId === "string" ? args.operationId : ""
        });
      case APP_ARTIFACT_REVISE_TOOL:
        return artifactService.revise(member, {
          conversationId,
          ...ref,
          baseVersion: artifactToolNumber(args.baseVersion),
          content: typeof args.content === "string" ? args.content : "",
          note: artifactToolString(args.note)
        });
      case APP_ARTIFACT_RENAME_TOOL:
        return artifactService.rename(member, {
          conversationId,
          ...ref,
          newName: typeof args.newName === "string" ? args.newName : ""
        });
      case APP_ARTIFACT_SIGN_TOOL:
        return artifactService.sign(member, {
          conversationId,
          ...ref,
          version: artifactToolOptionalNumber(args.version)
        });
      case APP_ARTIFACT_SET_ACCESS_TOOL:
        return artifactService.updateAccess(member, {
          conversationId,
          ...ref,
          owner: artifactToolString(args.owner),
          contributors: artifactToolStringArray(args.contributors),
          requiredSigners: artifactToolStringArray(args.requiredSigners),
          labels: artifactToolStringArray(args.labels)
        });
      case APP_ARTIFACT_SET_ARCHIVED_TOOL:
        return artifactService.setArchived(member, {
          conversationId,
          ...ref,
          archived: args.archived as boolean
        });
      default:
        throw new Error(`Unknown artifact tool: ${toolName}.`);
    }
  };
}

function artifactToolNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return Number.NaN;
}

function artifactToolOptionalNumber(value: unknown): number | undefined {
  return value === undefined || value === null ? undefined : artifactToolNumber(value);
}

function artifactToolString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function artifactToolStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function artifactToolAudiencePolicy(value: unknown): ArtifactDraftAudiencePolicyByAuthor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value).map(([author, rawPolicy]) => {
    const policy = rawPolicy && typeof rawPolicy === "object" && !Array.isArray(rawPolicy)
      ? rawPolicy as Record<string, unknown>
      : {};
    return [author, {
      allowedReaders: artifactToolStringArray(policy.allowedReaders) ?? [],
      requiredReaders: artifactToolStringArray(policy.requiredReaders) ?? []
    }];
  }));
}

function artifactToolSources(value: unknown): PublishArtifactSourceRequest[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const source = entry as Record<string, unknown>;
    const draftId = artifactToolString(source.draftId);
    const disposition = source.disposition === "considered" || source.disposition === "excluded"
      ? source.disposition
      : undefined;
    if (!draftId || !disposition) {
      return [];
    }
    return [{
      draftId,
      disposition,
      exclusionRationale: artifactToolString(source.exclusionRationale)
    }];
  });
}
