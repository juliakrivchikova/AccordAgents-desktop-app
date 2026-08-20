import type { ChatAppToolCapability } from "./types";
import { hasChatAppToolCapability } from "./appTools";

export type AppMcpToolEffect = "app-managed" | "repository-filesystem" | "permission-bridge";

export interface AppMcpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
  annotations?: Readonly<Record<string, boolean>>;
}

export type RemoteAppMcpToolHandler =
  | "permissions-request"
  | "chat-get-context"
  | "chat-get-participants"
  | "chat-read-messages"
  | "chat-send-message"
  | "chat-list-attachments"
  | "chat-read-attachment";

export interface AppMcpToolContract {
  name: string;
  policyOrder: number;
  capability?: ChatAppToolCapability;
  effect: AppMcpToolEffect;
  desktop: Omit<AppMcpToolDefinition, "name">;
  worker?: {
    order: number;
    handler: RemoteAppMcpToolHandler;
    definition: Omit<AppMcpToolDefinition, "name">;
  };
}

export interface AppMcpToolPolicy {
  name: string;
  capability?: ChatAppToolCapability;
  effect: AppMcpToolEffect;
}

export const APP_ARTIFACT_CREATE_TOOL = "app_artifact_create";
export const APP_ARTIFACT_DIFF_TOOL = "app_artifact_diff";
export const APP_ARTIFACT_DRAFT_LIST_TOOL = "app_artifact_draft_list";
export const APP_ARTIFACT_DRAFT_READ_TOOL = "app_artifact_draft_read";
export const APP_ARTIFACT_DRAFT_REPLACE_TOOL = "app_artifact_draft_replace";
export const APP_ARTIFACT_DRAFT_SAVE_TOOL = "app_artifact_draft_save";
export const APP_ARTIFACT_DRAFT_SET_ROSTER_TOOL = "app_artifact_draft_set_roster";
export const APP_ARTIFACT_DRAFT_SUBMIT_TOOL = "app_artifact_draft_submit";
export const APP_ARTIFACT_DRAFT_WITHDRAW_TOOL = "app_artifact_draft_withdraw";
export const APP_ARTIFACT_LIST_TOOL = "app_artifact_list";
export const APP_ARTIFACT_PUBLISH_TOOL = "app_artifact_publish";
export const APP_ARTIFACT_READ_TOOL = "app_artifact_read";
export const APP_ARTIFACT_RENAME_TOOL = "app_artifact_rename";
export const APP_ARTIFACT_REVISE_TOOL = "app_artifact_revise";
export const APP_ARTIFACT_SET_ACCESS_TOOL = "app_artifact_set_access";
export const APP_ARTIFACT_SET_ARCHIVED_TOOL = "app_artifact_set_archived";
export const APP_ARTIFACT_SIGN_TOOL = "app_artifact_sign";
export const APP_CHAT_EXPORT_ATTACHMENT_TOOL = "app_chat_export_attachment";
export const APP_CHAT_GET_CONTEXT_TOOL = "app_chat_get_context";
export const APP_CHAT_GET_PARTICIPANT_ACTIVITY_TOOL = "app_chat_get_participant_activity";
export const APP_CHAT_GET_PARTICIPANT_REQUEST_STATUS_TOOL = "app_chat_get_participant_request_status";
export const APP_CHAT_GET_PARTICIPANTS_TOOL = "app_chat_get_participants";
export const APP_CHAT_LIST_ATTACHMENTS_TOOL = "app_chat_list_attachments";
export const APP_CHAT_REACT_TOOL = "app_chat_react";
export const APP_CHAT_READ_ATTACHMENT_TOOL = "app_chat_read_attachment";
export const APP_CHAT_READ_MESSAGES_TOOL = "app_chat_read_messages";
export const APP_CHAT_REQUEST_COMPACTION_TOOL = "app_chat_request_compaction";
export const APP_CHAT_REQUEST_PARTICIPANTS_TOOL = "app_chat_request_participants";
export const APP_CHAT_SEND_MESSAGE_TOOL = "app_chat_send_message";
export const APP_CHAT_SET_TITLE_TOOL = "app_chat_set_title";
export const APP_PARTICIPANTS_DESCRIBE_OPTIONS_TOOL = "app_participants_describe_options";
export const APP_PARTICIPANTS_REQUEST_CHANGE_TOOL = "app_participants_request_change";
export const APP_PERMISSIONS_REQUEST_CHANGE_TOOL = "app_permissions_request_change";
export const APP_ROLES_DESCRIBE_OPTIONS_TOOL = "app_roles_describe_options";
export const APP_ROLES_REQUEST_CHANGE_TOOL = "app_roles_request_change";
export const APP_ROSTER_DESCRIBE_OPTIONS_TOOL = "app_roster_describe_options";
export const APP_ROSTER_REQUEST_CHANGE_TOOL = "app_roster_request_change";
export const APP_TOOL_PERMISSION_TOOL = "app_tool_permission";

export const APP_ARTIFACT_TOOL_NAMES = [
  APP_ARTIFACT_LIST_TOOL,
  APP_ARTIFACT_READ_TOOL,
  APP_ARTIFACT_DIFF_TOOL,
  APP_ARTIFACT_CREATE_TOOL,
  APP_ARTIFACT_REVISE_TOOL,
  APP_ARTIFACT_RENAME_TOOL,
  APP_ARTIFACT_SIGN_TOOL,
  APP_ARTIFACT_SET_ACCESS_TOOL,
  APP_ARTIFACT_SET_ARCHIVED_TOOL,
  APP_ARTIFACT_DRAFT_LIST_TOOL,
  APP_ARTIFACT_DRAFT_READ_TOOL,
  APP_ARTIFACT_DRAFT_SAVE_TOOL,
  APP_ARTIFACT_DRAFT_SUBMIT_TOOL,
  APP_ARTIFACT_DRAFT_REPLACE_TOOL,
  APP_ARTIFACT_DRAFT_WITHDRAW_TOOL,
  APP_ARTIFACT_DRAFT_SET_ROSTER_TOOL,
  APP_ARTIFACT_PUBLISH_TOOL
] as const;

// Single source of truth for desktop exposure, worker exposure, schemas, and
// Auto preauthorization. Worker entries intentionally retain worker-specific
// descriptions and schemas where their behavior differs from the desktop.
export const APP_MCP_TOOL_CONTRACTS: readonly AppMcpToolContract[] = [
  {
    name: APP_TOOL_PERMISSION_TOOL,
    policyOrder: 11,
    effect: "permission-bridge",
    desktop: {
      "title": "Handle CLI Tool Permission",
      "description": "Claude Code permission-prompt bridge. Claude Code calls this MCP tool when a CLI tool request needs approval in a non-interactive chat run. The app shows the request to the User and returns a permission decision.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": true,
        "properties": {
          "tool_name": {
            "type": "string",
            "description": "Canonical tool name requesting permission, for example Bash, Write, or mcp__server__tool."
          },
          "toolName": {
            "type": "string",
            "description": "Alternate camelCase tool name field."
          },
          "tool_use_id": {
            "type": "string",
            "description": "Claude Code's native invocation id for this permission occurrence."
          },
          "toolUseId": {
            "type": "string",
            "description": "Alternate camelCase native invocation id field."
          },
          "input": {
            "type": "object",
            "additionalProperties": true,
            "description": "Tool input parameters."
          },
          "tool_input": {
            "type": "object",
            "additionalProperties": true,
            "description": "Alternate snake_case tool input field."
          },
          "reason": {
            "type": "string",
            "description": "Optional reason or explanation for the requested tool call."
          },
          "suggestions": {
            "type": "array",
            "description": "Optional permission-update suggestions from Claude Code."
          }
        }
      },
      "annotations": {
        "readOnlyHint": false,
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false
      }
    },
  },
  {
    name: APP_CHAT_GET_CONTEXT_TOOL,
    policyOrder: 0,
    effect: "app-managed",
    desktop: {
      "title": "Get Chat Context",
      "description": "Return the current chat conversation, requesting member, active turn metadata, and available context sources. This is read-only and scoped to the issued app token.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {}
      },
      "annotations": {
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false
      }
    },
    worker: {
      order: 1,
      handler: "chat-get-context",
      definition: {
        "title": "Get Chat Context Snapshot",
        "description": "Read the run-start chat context snapshot stored on the worker.",
        "inputSchema": {
          "type": "object",
          "additionalProperties": false,
          "properties": {}
        }
      }
    }
  },
  {
    name: APP_CHAT_GET_PARTICIPANTS_TOOL,
    policyOrder: 1,
    effect: "app-managed",
    desktop: {
      "title": "Get Chat Members",
      "description": "Return the current chat roster, role labels, provider details, and safe member capabilities for this chat. This is read-only.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {}
      },
      "annotations": {
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false
      }
    },
    worker: {
      order: 2,
      handler: "chat-get-participants",
      definition: {
        "title": "Get Chat Members Snapshot",
        "description": "Read member data from the run-start context snapshot.",
        "inputSchema": {
          "type": "object",
          "additionalProperties": false,
          "properties": {}
        }
      }
    }
  },
  {
    name: APP_CHAT_GET_PARTICIPANT_ACTIVITY_TOOL,
    policyOrder: 2,
    effect: "app-managed",
    desktop: {
      "title": "Get Chat Member Activity",
      "description": "Return one authoritative snapshot of every current chat member's roster status, active app-managed work, and latest finished message. This is read-only.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {}
      },
      "annotations": {
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false
      }
    },
  },
  {
    name: APP_CHAT_GET_PARTICIPANT_REQUEST_STATUS_TOOL,
    policyOrder: 3,
    effect: "app-managed",
    desktop: {
      "title": "Get Member Request Status",
      "description": "Return current status and available replies/errors for a previous member request. Use this to recover after timeout, interruption, approval delay, or session resume.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "requestId": {
            "type": "string",
            "description": "Optional member request batch id. If omitted, returns recent requests made by this member."
          }
        }
      },
      "annotations": {
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false
      }
    },
  },
  {
    name: APP_CHAT_READ_MESSAGES_TOOL,
    policyOrder: 4,
    effect: "app-managed",
    desktop: {
      "title": "Read Chat Messages",
      "description": "Read paginated chat messages from the current conversation, optionally filtered to one thread. Use this instead of rereading full history files when you need prior chat context.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "messageId": {
            "type": "string",
            "description": "Optional message id. When set, returns only that single message (with metadata.reactions) if it is visible to this turn; other filters are ignored. Use this to read the exact canonical message under approval."
          },
          "threadId": {
            "type": "string",
            "description": "Optional thread id to read only messages from one chat thread."
          },
          "beforeSequence": {
            "type": "integer",
            "minimum": 0,
            "description": "Optional exclusive upper sequence bound. Returns messages with sequence lower than this value."
          },
          "afterSequence": {
            "type": "integer",
            "minimum": 0,
            "description": "Optional exclusive lower sequence bound. Returns messages with sequence greater than this value."
          },
          "limit": {
            "type": "integer",
            "minimum": 1,
            "maximum": 200,
            "description": "Maximum number of messages to return. Defaults to recent focused context."
          }
        }
      },
      "annotations": {
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false
      }
    },
    worker: {
      order: 3,
      handler: "chat-read-messages",
      definition: {
        "title": "Read Chat Messages",
        "description": "Read paginated chat messages from the run-start snapshot, optionally filtered to one thread or one message id. Same result shape as the desktop tool. The window is fixed at run start: messages posted after this run began are not in it, and the page counts describe the snapshot, not the live conversation.",
        "inputSchema": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "messageId": {
              "type": "string"
            },
            "threadId": {
              "type": "string"
            },
            "beforeSequence": {
              "type": "integer",
              "minimum": 0
            },
            "afterSequence": {
              "type": "integer",
              "minimum": 0
            },
            "limit": {
              "type": "integer",
              "minimum": 1,
              "maximum": 200
            }
          }
        }
      }
    }
  },
  {
    name: APP_CHAT_LIST_ATTACHMENTS_TOOL,
    policyOrder: 5,
    effect: "app-managed",
    desktop: {
      "title": "List Chat Attachments",
      "description": "List image attachments visible to the current app token. Use this to discover attachment IDs, filenames, MIME types, dimensions, and source message IDs before reading image bytes.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "messageId": {
            "type": "string",
            "description": "Optional source message id. If omitted, returns visible attachments from the current conversation snapshot."
          },
          "threadId": {
            "type": "string",
            "description": "Optional chat thread id to list attachments from one thread."
          },
          "limit": {
            "type": "integer",
            "minimum": 1,
            "maximum": 100,
            "description": "Maximum number of attachment records to return. Defaults to 50."
          }
        }
      },
      "annotations": {
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false
      }
    },
    worker: {
      order: 5,
      handler: "chat-list-attachments",
      definition: {
        "title": "List Chat Image Attachments",
        "description": "List image attachments visible in the run-start snapshot, oldest first. Use this for attachment ids, then app_chat_read_attachment to see one.",
        "inputSchema": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "messageId": {
              "type": "string"
            },
            "threadId": {
              "type": "string"
            },
            "limit": {
              "type": "integer",
              "minimum": 1,
              "maximum": 50
            }
          }
        }
      }
    }
  },
  {
    name: APP_CHAT_READ_ATTACHMENT_TOOL,
    policyOrder: 6,
    effect: "app-managed",
    desktop: {
      "title": "Read Chat Attachment",
      "description": "Read one visible image attachment by attachmentId. The result includes metadata plus image content; use this when a message says it has an attached screenshot or image.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "attachmentId": {
            "type": "string",
            "description": "Attachment id from app_chat_list_attachments or message metadata."
          }
        },
        "required": [
          "attachmentId"
        ]
      },
      "annotations": {
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false
      }
    },
    worker: {
      order: 6,
      handler: "chat-read-attachment",
      definition: {
        "title": "Read Chat Image Attachment",
        "description": "Read one image attachment bundled with this run and return it as image content. Only attachments visible at run start are available.",
        "inputSchema": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "attachmentId"
          ],
          "properties": {
            "attachmentId": {
              "type": "string"
            }
          }
        }
      }
    }
  },
  {
    name: APP_CHAT_EXPORT_ATTACHMENT_TOOL,
    policyOrder: 7,
    effect: "repository-filesystem",
    desktop: {
      "title": "Export Chat Attachment",
      "description": "Copy one visible image attachment into the selected repository using a repository-relative targetPath. Requires workspace write permission for this member run.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "attachmentId": {
            "type": "string",
            "description": "Attachment id from app_chat_list_attachments or message metadata."
          },
          "targetPath": {
            "type": "string",
            "description": "Repository-relative destination file path, for example screenshots/example.png. Absolute paths and traversal are rejected."
          },
          "overwrite": {
            "type": "boolean",
            "description": "When true, replace an existing regular file. Existing symlinks and directories are always rejected."
          }
        },
        "required": [
          "attachmentId",
          "targetPath"
        ]
      },
      "annotations": {
        "readOnlyHint": false,
        "destructiveHint": true,
        "idempotentHint": false,
        "openWorldHint": false
      }
    },
  },
  {
    name: APP_CHAT_REACT_TOOL,
    policyOrder: 8,
    effect: "app-managed",
    desktop: {
      "title": "React To Chat Message",
      "description": "Add or toggle an emoji reaction on a specific message. To react, call this with the message id from app_chat_read_messages and an allowed emoji.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "messageId": {
            "type": "string",
            "description": "Message id returned by app_chat_read_messages."
          },
          "emoji": {
            "type": "string",
            "enum": [
              "✅",
              "👍",
              "👀",
              "🎉",
              "❌"
            ],
            "description": "Allowed reaction emoji."
          }
        },
        "required": [
          "messageId",
          "emoji"
        ]
      },
      "annotations": {
        "readOnlyHint": false,
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false
      }
    },
  },
  {
    name: APP_CHAT_SEND_MESSAGE_TOOL,
    policyOrder: 9,
    effect: "app-managed",
    desktop: {
      "title": "Send Chat Message",
      "description": "Post a member message authored by you IMMEDIATELY, so other members and User can see and react to it before your turn ends, and return its messageId and sequence. Use this ONLY when you need a message visible mid-turn — for example to publish something others will react to during this same turn (a canonical resolution) and you need its messageId now. Do NOT use this for an ordinary answer or reply: your normal turn response is already shared with everyone when your turn ends, so sending it with this tool just duplicates it and leaves your turn with nothing to say. The returned messageId can be passed to app_chat_react. Optional image attachments are imported from sourcePath files inside the selected repository when this run has repoRead; v1 accepts only PNG, JPEG, and WebP images.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "content": {
            "type": "string",
            "description": "Message content. Must be non-empty after trimming unless attachments contains at least one image."
          },
          "attachments": {
            "type": "array",
            "minItems": 1,
            "maxItems": 5,
            "description": "Optional image attachments to import from files visible to this run. V1 accepts PNG, JPEG, and WebP only.",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "kind": {
                  "type": "string",
                  "enum": [
                    "image"
                  ],
                  "description": "Attachment kind. V1 supports image only."
                },
                "sourcePath": {
                  "type": "string",
                  "description": "Absolute or repository-relative path to an image file inside the selected repository."
                },
                "filename": {
                  "type": "string",
                  "description": "Optional display filename. The app normalizes the filename and extension."
                },
                "mimeType": {
                  "type": "string",
                  "enum": [
                    "image/png",
                    "image/jpeg",
                    "image/webp"
                  ],
                  "description": "Optional expected MIME type. The app validates this against the image bytes."
                }
              },
              "required": [
                "kind",
                "sourcePath"
              ]
            }
          },
          "threadId": {
            "type": "string",
            "description": "Optional visible thread id to post into. Defaults to the active turn's thread."
          },
          "parentMessageId": {
            "type": "string",
            "description": "Optional visible parent message id (e.g. User's original request). Must be visible to this turn."
          },
          "chatThreadRootId": {
            "type": "string",
            "description": "Optional visible thread root message id. Must be visible to this turn."
          },
          "accordResolution": {
            "type": "object",
            "additionalProperties": false,
            "description": "Optional lightweight metadata for verification/debugging of an /accord resolution. Not an approval engine; the canonical approval is the ✅ reactor set.",
            "properties": {
              "version": {
                "type": "integer",
                "minimum": 1
              },
              "sourceMessageId": {
                "type": "string"
              },
              "selectedParticipantIds": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "requiredApproverIds": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "supersedesMessageId": {
                "type": "string"
              },
              "status": {
                "type": "string"
              }
            }
          }
        }
      },
      "annotations": {
        "readOnlyHint": false,
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false
      }
    },
    worker: {
      order: 4,
      handler: "chat-send-message",
      definition: {
        "title": "Post A Message Mid-Run",
        "description": "Post a message to the chat while this run is still working. The post is queued on the worker and appears when the desktop next drains this run, so it is not instant and returns no message id. Text only.",
        "inputSchema": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "content"
          ],
          "properties": {
            "content": {
              "type": "string"
            }
          }
        }
      }
    }
  },
  {
    name: APP_CHAT_SET_TITLE_TOOL,
    policyOrder: 10,
    effect: "app-managed",
    desktop: {
      "title": "Set Chat Title",
      "description": "Set a concise title for this chat. Intended for the first eligible member turn only; the backend validates eligibility, sanitizes the title, applies the first accepted title, and ignores later or ineligible calls.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "title": {
            "type": "string",
            "description": "Concise title based on the user's intent. Omit member handles, slash commands, model/provider names, and generic words like Chat."
          }
        },
        "required": [
          "title"
        ]
      },
      "annotations": {
        "readOnlyHint": false,
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false
      }
    },
  },
  {
    name: APP_ARTIFACT_LIST_TOOL,
    policyOrder: 12,
    effect: "app-managed",
    desktop: {
      "title": "List Artifacts",
      "description": "List this chat's artifacts as lightweight summaries (id, name, current version, approval state, owner/contributors, last-updated) WITHOUT contents. Artifacts are durable shared work products (plans, QA checklists, specs, todo lists — any name works). Reference one in chat as [name](#artifact:<id>); the link always shows the artifact's current name and never embeds its body.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {}
      },
      "annotations": {
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false
      }
    },
  },
  {
    name: APP_ARTIFACT_READ_TOOL,
    policyOrder: 13,
    effect: "app-managed",
    desktop: {
      "title": "Read Artifact",
      "description": "Read one artifact. Published artifacts return the current version by default; collecting artifacts return only drafts visible to the caller plus durable draft progress. Set includeHistory for published version metadata.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "artifactId": {
            "type": "string",
            "description": "Stable artifact id. Preferred: it survives renames."
          },
          "name": {
            "type": "string",
            "description": "Current artifact name (case-insensitive) as an alternative to artifactId."
          },
          "version": {
            "type": "integer",
            "minimum": 1,
            "description": "Specific version to read. Defaults to the current version."
          },
          "includeHistory": {
            "type": "boolean",
            "description": "Also return version history metadata (no contents)."
          }
        }
      },
      "annotations": {
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false
      }
    },
  },
  {
    name: APP_ARTIFACT_DIFF_TOOL,
    policyOrder: 14,
    effect: "app-managed",
    desktop: {
      "title": "Compare Artifact Versions",
      "description": "Return a unified line diff between two versions of an artifact instead of both full bodies.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "artifactId": {
            "type": "string",
            "description": "Stable artifact id. Preferred: it survives renames."
          },
          "name": {
            "type": "string",
            "description": "Current artifact name (case-insensitive) as an alternative to artifactId."
          },
          "fromVersion": {
            "type": "integer",
            "minimum": 1
          },
          "toVersion": {
            "type": "integer",
            "minimum": 1
          }
        },
        "required": [
          "fromVersion",
          "toVersion"
        ]
      },
      "annotations": {
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false
      }
    },
  },
  {
    name: APP_ARTIFACT_CREATE_TOOL,
    policyOrder: 15,
    effect: "app-managed",
    desktop: {
      "title": "Create Artifact",
      "description": "Create a durable artifact. Omit initialState (or use published) for an ordinary v1 artifact. Use collecting_drafts with a roster, per-author audience policy, and stable operationId to collect private drafts before publishing v1.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "name": {
            "type": "string",
            "description": "Unique human-readable name within this chat (renameable later)."
          },
          "initialState": {
            "type": "string",
            "enum": [
              "published",
              "collecting_drafts"
            ]
          },
          "content": {
            "type": "string",
            "description": "Free-form text content of version 1. Required for published; omit while collecting drafts."
          },
          "note": {
            "type": "string",
            "description": "Optional short note describing version 1."
          },
          "contributors": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "Members allowed to revise/rename (owner always can)."
          },
          "requiredSigners": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "Members whose signatures approve a version. Only they can sign."
          },
          "labels": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "Optional free-form labels; never required, never a fixed set."
          },
          "allowedDraftAuthors": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "requiredDraftAuthors": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "audiencePolicyByAuthor": {
            "type": "object",
            "additionalProperties": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "allowedReaders": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "requiredReaders": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                }
              },
              "required": [
                "allowedReaders",
                "requiredReaders"
              ]
            },
            "description": "Per-author reader policy. The User and draft author are always implicit readers."
          },
          "operationId": {
            "type": "string",
            "description": "Stable retry key. Required for collecting_drafts."
          }
        },
        "required": [
          "name"
        ],
        "allOf": [
          {
            "if": {
              "properties": {
                "initialState": {
                  "const": "collecting_drafts"
                }
              },
              "required": [
                "initialState"
              ]
            },
            "then": {
              "required": [
                "allowedDraftAuthors",
                "requiredDraftAuthors",
                "audiencePolicyByAuthor",
                "operationId"
              ],
              "not": {
                "anyOf": [
                  {
                    "required": [
                      "content"
                    ]
                  },
                  {
                    "required": [
                      "note"
                    ]
                  },
                  {
                    "required": [
                      "requiredSigners"
                    ]
                  }
                ]
              }
            },
            "else": {
              "required": [
                "content"
              ],
              "not": {
                "anyOf": [
                  {
                    "required": [
                      "allowedDraftAuthors"
                    ]
                  },
                  {
                    "required": [
                      "requiredDraftAuthors"
                    ]
                  },
                  {
                    "required": [
                      "audiencePolicyByAuthor"
                    ]
                  },
                  {
                    "required": [
                      "operationId"
                    ]
                  }
                ]
              }
            }
          }
        ]
      },
      "annotations": {
        "readOnlyHint": false,
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false
      }
    },
  },
  {
    name: APP_ARTIFACT_REVISE_TOOL,
    policyOrder: 16,
    effect: "app-managed",
    desktop: {
      "title": "Revise Artifact",
      "description": "Create the next version of an artifact with new full content. You MUST pass baseVersion = the version your edit is based on; if someone else already revised it you get a stale_version error carrying the current version and its content — redo your edit on top of that and retry. Nothing is ever silently overwritten. Only the owner and contributors can revise. New versions start unsigned.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "artifactId": {
            "type": "string",
            "description": "Stable artifact id. Preferred: it survives renames."
          },
          "name": {
            "type": "string",
            "description": "Current artifact name (case-insensitive) as an alternative to artifactId."
          },
          "baseVersion": {
            "type": "integer",
            "minimum": 1,
            "description": "The version this edit was based on (optimistic concurrency guard)."
          },
          "content": {
            "type": "string",
            "description": "Complete new content for the next version."
          },
          "note": {
            "type": "string",
            "description": "Optional short note describing the change."
          }
        },
        "required": [
          "baseVersion",
          "content"
        ]
      },
      "annotations": {
        "readOnlyHint": false,
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false
      }
    },
  },
  {
    name: APP_ARTIFACT_RENAME_TOOL,
    policyOrder: 17,
    effect: "app-managed",
    desktop: {
      "title": "Rename Artifact",
      "description": "Change an artifact's display name. Label-only: no new version, signatures intact, and existing [..](#artifact:<id>) references keep working and show the new name. The freed name may be reused by a different artifact without redirecting old references. Owner and contributors only.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "artifactId": {
            "type": "string",
            "description": "Stable artifact id. Preferred: it survives renames."
          },
          "name": {
            "type": "string",
            "description": "Current artifact name (case-insensitive) as an alternative to artifactId."
          },
          "newName": {
            "type": "string",
            "description": "New unique name within this chat."
          }
        },
        "required": [
          "newName"
        ]
      },
      "annotations": {
        "readOnlyHint": false,
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false
      }
    },
  },
  {
    name: APP_ARTIFACT_SIGN_TOOL,
    policyOrder: 18,
    effect: "app-managed",
    desktop: {
      "title": "Sign Artifact Version",
      "description": "Sign a specific version (defaults to current) to record your approval. Only members of the artifact's required-signer set can sign. A signature sticks to the version it was made on; later revisions start unsigned while earlier signatures stay in history. The artifact is fully approved when every required signer has signed the current version.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "artifactId": {
            "type": "string",
            "description": "Stable artifact id. Preferred: it survives renames."
          },
          "name": {
            "type": "string",
            "description": "Current artifact name (case-insensitive) as an alternative to artifactId."
          },
          "version": {
            "type": "integer",
            "minimum": 1,
            "description": "Version to sign. Defaults to the current version."
          }
        }
      },
      "annotations": {
        "readOnlyHint": false,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false
      }
    },
  },
  {
    name: APP_ARTIFACT_SET_ACCESS_TOOL,
    policyOrder: 19,
    effect: "app-managed",
    desktop: {
      "title": "Manage Artifact Access",
      "description": "Owner-only: transfer ownership, or replace the contributor set, required-signer set, or labels. Omitted fields stay unchanged; provided arrays replace the existing set.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "artifactId": {
            "type": "string",
            "description": "Stable artifact id. Preferred: it survives renames."
          },
          "name": {
            "type": "string",
            "description": "Current artifact name (case-insensitive) as an alternative to artifactId."
          },
          "owner": {
            "type": "string",
            "description": "New owner (must be a chat member)."
          },
          "contributors": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "Replacement contributor set."
          },
          "requiredSigners": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "Replacement required-signer set."
          },
          "labels": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "Replacement label list."
          }
        }
      },
      "annotations": {
        "readOnlyHint": false,
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false
      }
    },
  },
  {
    name: APP_ARTIFACT_SET_ARCHIVED_TOOL,
    policyOrder: 20,
    effect: "app-managed",
    desktop: {
      "title": "Archive Artifact",
      "description": "Archive or restore one artifact without deleting versions, drafts, signatures, or stable links. Archived artifacts stay readable and appear under the Archived tab. User or owner only.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "artifactId": {
            "type": "string",
            "description": "Stable artifact id. Preferred: it survives renames."
          },
          "name": {
            "type": "string",
            "description": "Current artifact name (case-insensitive) as an alternative to artifactId."
          },
          "archived": {
            "type": "boolean",
            "description": "true archives the artifact; false restores it to Active."
          }
        },
        "required": [
          "archived"
        ]
      },
      "annotations": {
        "readOnlyHint": false,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false
      }
    },
  },
  {
    name: APP_ARTIFACT_DRAFT_LIST_TOOL,
    policyOrder: 21,
    effect: "app-managed",
    desktop: {
      "title": "List Artifact Drafts",
      "description": "List durable draft submissions for a collecting artifact. Unauthorized editing drafts are hidden; submitted drafts expose metadata only unless their reader ACL permits the caller. The User can read all drafts.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "artifactId": {
            "type": "string",
            "description": "Stable artifact id. Preferred: it survives renames."
          },
          "name": {
            "type": "string",
            "description": "Current artifact name (case-insensitive) as an alternative to artifactId."
          }
        }
      },
      "annotations": {
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false
      }
    },
  },
  {
    name: APP_ARTIFACT_DRAFT_READ_TOOL,
    policyOrder: 22,
    effect: "app-managed",
    desktop: {
      "title": "Read Artifact Draft",
      "description": "Read one draft through its content ACL. The User always has access; otherwise only its author and explicitly selected readers may read the body, including while it is still being edited.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "artifactId": {
            "type": "string",
            "description": "Stable artifact id. Preferred: it survives renames."
          },
          "name": {
            "type": "string",
            "description": "Current artifact name (case-insensitive) as an alternative to artifactId."
          },
          "draftId": {
            "type": "string"
          }
        },
        "required": [
          "draftId"
        ]
      },
      "annotations": {
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false
      }
    },
  },
  {
    name: APP_ARTIFACT_DRAFT_SAVE_TOOL,
    policyOrder: 23,
    effect: "app-managed",
    desktop: {
      "title": "Save Artifact Draft",
      "description": "Create or edit your own unsubmitted draft. The User and author are implicit readers; selected readers can inspect the body before submission and must satisfy the artifact's policy. Pass expectedEditRevision=0 to create and a stable operationId for retries.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "artifactId": {
            "type": "string",
            "description": "Stable artifact id. Preferred: it survives renames."
          },
          "name": {
            "type": "string",
            "description": "Current artifact name (case-insensitive) as an alternative to artifactId."
          },
          "draftId": {
            "type": "string"
          },
          "expectedEditRevision": {
            "type": "integer",
            "minimum": 0
          },
          "content": {
            "type": "string"
          },
          "readers": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "operationId": {
            "type": "string"
          }
        },
        "required": [
          "expectedEditRevision",
          "content",
          "readers",
          "operationId"
        ]
      },
      "annotations": {
        "readOnlyHint": false,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false
      }
    },
  },
  {
    name: APP_ARTIFACT_DRAFT_SUBMIT_TOOL,
    policyOrder: 24,
    effect: "app-managed",
    desktop: {
      "title": "Submit Artifact Draft",
      "description": "Freeze your editing draft as submitted. Submission is immutable; replace or withdraw explicitly instead of editing it.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "artifactId": {
            "type": "string",
            "description": "Stable artifact id. Preferred: it survives renames."
          },
          "name": {
            "type": "string",
            "description": "Current artifact name (case-insensitive) as an alternative to artifactId."
          },
          "draftId": {
            "type": "string"
          },
          "expectedEditRevision": {
            "type": "integer",
            "minimum": 1
          },
          "operationId": {
            "type": "string"
          }
        },
        "required": [
          "draftId",
          "expectedEditRevision",
          "operationId"
        ]
      },
      "annotations": {
        "readOnlyHint": false,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false
      }
    },
  },
  {
    name: APP_ARTIFACT_DRAFT_REPLACE_TOOL,
    policyOrder: 25,
    effect: "app-managed",
    desktop: {
      "title": "Create Editable Draft Replacement",
      "description": "Create an editable replacement for your own submitted draft while preserving the original draft and its provenance. This does not submit or freeze the replacement: call Submit Artifact Draft afterward.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "artifactId": {
            "type": "string",
            "description": "Stable artifact id. Preferred: it survives renames."
          },
          "name": {
            "type": "string",
            "description": "Current artifact name (case-insensitive) as an alternative to artifactId."
          },
          "supersedesDraftId": {
            "type": "string"
          },
          "content": {
            "type": "string"
          },
          "readers": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "operationId": {
            "type": "string"
          }
        },
        "required": [
          "supersedesDraftId",
          "content",
          "readers",
          "operationId"
        ]
      },
      "annotations": {
        "readOnlyHint": false,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false
      }
    },
  },
  {
    name: APP_ARTIFACT_DRAFT_WITHDRAW_TOOL,
    policyOrder: 26,
    effect: "app-managed",
    desktop: {
      "title": "Withdraw Artifact Draft",
      "description": "Withdraw your submitted draft without deleting its durable provenance.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "artifactId": {
            "type": "string",
            "description": "Stable artifact id. Preferred: it survives renames."
          },
          "name": {
            "type": "string",
            "description": "Current artifact name (case-insensitive) as an alternative to artifactId."
          },
          "draftId": {
            "type": "string"
          },
          "operationId": {
            "type": "string"
          }
        },
        "required": [
          "draftId",
          "operationId"
        ]
      },
      "annotations": {
        "readOnlyHint": false,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false
      }
    },
  },
  {
    name: APP_ARTIFACT_DRAFT_SET_ROSTER_TOOL,
    policyOrder: 27,
    effect: "app-managed",
    desktop: {
      "title": "Update Artifact Draft Roster",
      "description": "Owner-only: update draft authors and per-author audience policy using an optimistic roster revision and stable retry key.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "artifactId": {
            "type": "string",
            "description": "Stable artifact id. Preferred: it survives renames."
          },
          "name": {
            "type": "string",
            "description": "Current artifact name (case-insensitive) as an alternative to artifactId."
          },
          "allowedDraftAuthors": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "requiredDraftAuthors": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "audiencePolicyByAuthor": {
            "type": "object",
            "additionalProperties": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "allowedReaders": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "requiredReaders": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                }
              },
              "required": [
                "allowedReaders",
                "requiredReaders"
              ]
            },
            "description": "Per-author reader policy. The User and draft author are always implicit readers."
          },
          "expectedDraftRosterRevision": {
            "type": "integer",
            "minimum": 0
          },
          "operationId": {
            "type": "string"
          }
        },
        "required": [
          "allowedDraftAuthors",
          "requiredDraftAuthors",
          "audiencePolicyByAuthor",
          "expectedDraftRosterRevision",
          "operationId"
        ]
      },
      "annotations": {
        "readOnlyHint": false,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false
      }
    },
  },
  {
    name: APP_ARTIFACT_PUBLISH_TOOL,
    policyOrder: 28,
    effect: "app-managed",
    desktop: {
      "title": "Publish Artifact Version 1",
      "description": "Owner-only: publish version 1 after every required author has a current submitted draft. Publishing records structured version sources without creating signatures.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "artifactId": {
            "type": "string",
            "description": "Stable artifact id. Preferred: it survives renames."
          },
          "name": {
            "type": "string",
            "description": "Current artifact name (case-insensitive) as an alternative to artifactId."
          },
          "content": {
            "type": "string"
          },
          "note": {
            "type": "string"
          },
          "requiredSigners": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "sources": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "draftId": {
                  "type": "string"
                },
                "disposition": {
                  "type": "string",
                  "enum": [
                    "considered",
                    "excluded"
                  ]
                },
                "exclusionRationale": {
                  "type": "string"
                }
              },
              "required": [
                "draftId",
                "disposition"
              ]
            }
          },
          "operationId": {
            "type": "string"
          }
        },
        "required": [
          "content",
          "requiredSigners",
          "sources",
          "operationId"
        ]
      },
      "annotations": {
        "readOnlyHint": false,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false
      }
    },
  },
  {
    name: APP_CHAT_REQUEST_PARTICIPANTS_TOOL,
    policyOrder: 29,
    effect: "app-managed",
    capability: "participants.request",
    desktop: {
      "title": "Request Chat Members",
      "description": "Ask one or more current chat members to respond to a concrete prompt. The app validates policy, may request User approval, runs approved members, and either auto-resumes the requester or returns inline replies when requested.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "requests": {
            "type": "array",
            "minItems": 1,
            "maxItems": 4,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "target": {
                  "type": "string",
                  "description": "Target member handle, with or without @."
                },
                "prompt": {
                  "type": "string",
                  "description": "Concrete question or task for the target member."
                },
                "reason": {
                  "type": "string",
                  "description": "Optional brief reason this member input is needed."
                }
              },
              "required": [
                "target",
                "prompt"
              ]
            }
          },
          "timeoutMs": {
            "type": "integer",
            "minimum": 1000,
            "maximum": 300000,
            "description": "Optional bounded wait for replies. Defaults to 120000ms."
          },
          "resumeRequester": {
            "type": "boolean",
            "description": "Whether the app should return control in a fresh requester turn. Defaults to true and also applies when replies finish before timeout. Set false to receive completed replies inline."
          }
        },
        "required": [
          "requests"
        ]
      },
      "annotations": {
        "readOnlyHint": false,
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false
      }
    },
  },
  {
    name: APP_CHAT_REQUEST_COMPACTION_TOOL,
    policyOrder: 30,
    effect: "app-managed",
    capability: "compaction.request",
    desktop: {
      "title": "Request Context Compaction",
      "description": "Request compaction of your own provider session after the current turn finishes. The app validates permission, active-session status, duplicate requests, and cooldown. Optional instructions may preserve a specific focus during compaction.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "instructions": {
            "type": "string",
            "description": "Optional focus instructions for the compacted context."
          }
        }
      },
      "annotations": {
        "readOnlyHint": false,
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false
      }
    },
  },
  {
    name: APP_PERMISSIONS_REQUEST_CHANGE_TOOL,
    policyOrder: 31,
    effect: "app-managed",
    capability: "permissions.request",
    desktop: {
      "title": "Request Chat Permission Change",
      "description": "Request a permission change for this chat member, or pass a prior requestId to recover its status idempotently. Use portable for repoRead/workspaceWrite/webAccess, shellRules for command-specific shell rules, providerNative for Claude Code allowedTools tokens, or githubApp for GitHub App repository permissions. Provider-native grants are rejected unless the requester is a Claude Code member. The app validates the request and may return already_granted (the capability is already available for this run) or pending_user_approval for User approval.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "requestId": {
            "type": "string",
            "description": "Stable permission request id returned by an earlier call. When present, the tool returns that request's current status instead of creating a new request."
          },
          "kind": {
            "type": "string",
            "enum": [
              "portable",
              "shellRules",
              "providerNative",
              "githubApp"
            ],
            "description": "Permission request kind."
          },
          "reason": {
            "type": "string",
            "description": "Brief reason the member needs the requested permission."
          },
          "permissions": {
            "type": "array",
            "minItems": 1,
            "items": {
              "type": "string"
            },
            "description": "Portable grants repoRead/workspaceWrite/webAccess when kind is portable, or GitHub App permission tokens such as contents:write when kind is githubApp."
          },
          "rules": {
            "type": "array",
            "minItems": 1,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "action": {
                  "type": "string",
                  "enum": [
                    "allow",
                    "ask",
                    "deny"
                  ]
                },
                "match": {
                  "type": "string",
                  "enum": [
                    "exact",
                    "prefix"
                  ]
                },
                "pattern": {
                  "type": "string",
                  "description": "Literal shell command pattern, such as git status or git diff."
                }
              },
              "required": [
                "action",
                "match",
                "pattern"
              ]
            },
            "description": "Command-specific shell rules to request when kind is shellRules."
          },
          "provider": {
            "type": "string",
            "enum": [
              "claude-code"
            ],
            "description": "Provider for provider-native grants."
          },
          "allowedTools": {
            "type": "array",
            "minItems": 1,
            "items": {
              "type": "string"
            },
            "description": "Literal Claude Code allowedTools tokens to request when kind is providerNative."
          },
          "repository_full_name": {
            "type": "string",
            "description": "GitHub repository full name, owner/repo, when kind is githubApp."
          }
        }
      },
      "annotations": {
        "readOnlyHint": false,
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false
      }
    },
    worker: {
      order: 0,
      handler: "permissions-request",
      definition: {
        "title": "Request Permission Change",
        "description": "Queue a permission request for desktop approval when the desktop reconnects. Supports portable, shellRules, providerNative, and githubApp request kinds.",
        "inputSchema": {
          "type": "object",
          "additionalProperties": true
        }
      }
    }
  },
  {
    name: APP_ROLES_DESCRIBE_OPTIONS_TOOL,
    policyOrder: 32,
    effect: "app-managed",
    capability: "participants.manage",
    desktop: {
      "title": "Describe Chat Roles",
      "description": "Return available AccordAgents chat roles, including built-in roles and custom roles. This is read-only.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {}
      },
      "annotations": {
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false
      }
    },
  },
  {
    name: APP_ROLES_REQUEST_CHANGE_TOOL,
    policyOrder: 33,
    effect: "app-managed",
    capability: "participants.manage",
    desktop: {
      "title": "Request Role Change",
      "description": "Request creation, editing, or deletion of AccordAgents chat roles. Roles are reusable definitions separate from members. To delete a custom role, send type \"archive_role\" with role.roleConfigId; built-in roles cannot be deleted and a role still used by saved members cannot be deleted.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "reason": {
            "type": "string"
          },
          "operations": {
            "type": "array",
            "minItems": 1,
            "maxItems": 4,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "type": {
                  "type": "string",
                  "enum": [
                    "create_role",
                    "edit_role",
                    "archive_role"
                  ]
                },
                "role": {
                  "type": "object",
                  "additionalProperties": false,
                  "properties": {
                    "roleConfigId": {
                      "type": "string",
                      "description": "Required for edit_role and archive_role: the id of the existing role."
                    },
                    "draftRoleRef": {
                      "type": "string",
                      "description": "Temporary role reference for pending grouped-review create_role operations. Use it in a following member request only when the role request response is pending_user_approval; auto_applied responses return a persisted roleConfigId instead."
                    },
                    "label": {
                      "type": "string"
                    },
                    "instructions": {
                      "type": "string"
                    },
                    "participantDefaults": {
                      "type": "object",
                      "additionalProperties": false,
                      "properties": {
                        "autoWatch": {
                          "type": "boolean"
                        },
                        "requestParticipants": {
                          "type": "string",
                          "enum": [
                            "ask",
                            "allow",
                            "deny"
                          ]
                        },
                        "requestCompaction": {
                          "type": "string",
                          "enum": [
                            "ask",
                            "allow",
                            "deny"
                          ]
                        },
                        "manageRolesParticipants": {
                          "type": "string",
                          "enum": [
                            "ask",
                            "allow",
                            "deny"
                          ]
                        }
                      },
                      "description": "Default member behavior for members using this role. manageRolesParticipants controls whether members with this role can manage roles and chat members."
                    }
                  }
                }
              },
              "required": [
                "type",
                "role"
              ]
            }
          }
        },
        "required": [
          "operations"
        ]
      },
      "annotations": {
        "readOnlyHint": false,
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false
      }
    },
  },
  {
    name: APP_PARTICIPANTS_DESCRIBE_OPTIONS_TOOL,
    policyOrder: 34,
    effect: "app-managed",
    capability: "participants.manage",
    desktop: {
      "title": "Describe Chat Members",
      "description": "Return saved member presets, current chat members, available roles, CLI providers, model options, and validation rules. This is read-only.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {}
      },
      "annotations": {
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false
      }
    },
  },
  {
    name: APP_PARTICIPANTS_REQUEST_CHANGE_TOOL,
    policyOrder: 35,
    effect: "app-managed",
    capability: "participants.manage",
    desktop: {
      "title": "Request Member Change",
      "description": "Request adding a new member to the current chat, optionally saving it as a reusable preset, or adding an existing saved member preset to the chat.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "reason": {
            "type": "string"
          },
          "operations": {
            "type": "array",
            "minItems": 1,
            "maxItems": 12,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "type": {
                  "type": "string",
                  "enum": [
                    "add_new_participant_to_chat",
                    "add_existing_participant_to_chat"
                  ]
                },
                "saveAsPreset": {
                  "type": "boolean"
                },
                "participantConfigId": {
                  "type": "string"
                },
                "participant": {
                  "type": "object",
                  "additionalProperties": false,
                  "properties": {
                    "handle": {
                      "type": "string"
                    },
                    "roleConfigId": {
                      "type": "string"
                    },
                    "kind": {
                      "type": "string",
                      "enum": [
                        "codex-cli",
                        "claude-code",
                        "gemini-cli"
                      ]
                    },
                    "model": {
                      "type": "string"
                    },
                    "reasoningEffort": {
                      "type": "string",
                      "enum": [
                        "none",
                        "minimal",
                        "low",
                        "medium",
                        "high",
                        "xhigh",
                        "max"
                      ]
                    },
                    "avatarId": {
                      "type": "string"
                    },
                    "agentMode": {
                      "type": "string",
                      "enum": [
                        "default",
                        "plan",
                        "auto"
                      ]
                    },
                    "permissions": {
                      "type": "object",
                      "additionalProperties": false,
                      "properties": {
                        "repoRead": {
                          "type": "boolean"
                        },
                        "workspaceWrite": {
                          "type": "boolean"
                        },
                        "webAccess": {
                          "type": "boolean"
                        },
                        "requestParticipants": {
                          "type": "string",
                          "enum": [
                            "ask",
                            "allow",
                            "deny"
                          ]
                        },
                        "requestCompaction": {
                          "type": "string",
                          "enum": [
                            "ask",
                            "allow",
                            "deny"
                          ]
                        },
                        "manageRolesParticipants": {
                          "type": "string",
                          "enum": [
                            "ask",
                            "allow",
                            "deny"
                          ],
                          "description": "Member-specific role/member management behavior. Omit to inherit the selected role default."
                        },
                        "shell": {
                          "type": "object",
                          "additionalProperties": false,
                          "properties": {
                            "enabled": {
                              "type": "boolean"
                            },
                            "rules": {
                              "type": "array",
                              "items": {
                                "type": "object",
                                "additionalProperties": false,
                                "properties": {
                                  "action": {
                                    "type": "string",
                                    "enum": [
                                      "allow",
                                      "ask",
                                      "deny"
                                    ]
                                  },
                                  "pattern": {
                                    "type": "string"
                                  },
                                  "match": {
                                    "type": "string",
                                    "enum": [
                                      "exact",
                                      "prefix"
                                    ]
                                  }
                                },
                                "required": [
                                  "action",
                                  "pattern",
                                  "match"
                                ]
                              }
                            }
                          }
                        },
                        "providerNative": {
                          "type": "object",
                          "additionalProperties": true
                        }
                      }
                    }
                  },
                  "required": [
                    "handle",
                    "roleConfigId",
                    "kind"
                  ]
                }
              },
              "required": [
                "type"
              ]
            }
          }
        },
        "required": [
          "operations"
        ]
      },
      "annotations": {
        "readOnlyHint": false,
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false
      }
    },
  },
  {
    name: APP_ROSTER_DESCRIBE_OPTIONS_TOOL,
    policyOrder: 36,
    effect: "app-managed",
    capability: "participants.manage",
    desktop: {
      "title": "Describe Chat Roster Options",
      "description": "Return the roles, CLI providers, configured models, current roster, and validation rules available for AccordAgents chat roster changes. This is read-only.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {}
      },
      "annotations": {
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false
      }
    },
  },
  {
    name: APP_ROSTER_REQUEST_CHANGE_TOOL,
    policyOrder: 37,
    effect: "app-managed",
    capability: "participants.manage",
    desktop: {
      "title": "Request Chat Roster Change",
      "description": "Request an AccordAgents chat roster change. The app validates the request and asks User to approve it unless this administrator is already trusted for roster changes in this chat.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "reason": {
            "type": "string",
            "description": "Brief reason for the roster change."
          },
          "operations": {
            "type": "array",
            "minItems": 1,
            "maxItems": 12,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "type": {
                  "type": "string",
                  "enum": [
                    "add"
                  ]
                },
                "participant": {
                  "type": "object",
                  "additionalProperties": false,
                  "properties": {
                    "handle": {
                      "type": "string"
                    },
                    "roleConfigId": {
                      "type": "string"
                    },
                    "kind": {
                      "type": "string",
                      "enum": [
                        "codex-cli",
                        "claude-code",
                        "gemini-cli"
                      ]
                    },
                    "model": {
                      "type": "string"
                    },
                    "reasoningEffort": {
                      "type": "string",
                      "enum": [
                        "none",
                        "minimal",
                        "low",
                        "medium",
                        "high",
                        "xhigh",
                        "max"
                      ]
                    },
                    "avatarId": {
                      "type": "string"
                    },
                    "agentMode": {
                      "type": "string",
                      "enum": [
                        "default",
                        "plan",
                        "auto"
                      ]
                    },
                    "permissions": {
                      "type": "object",
                      "additionalProperties": false,
                      "properties": {
                        "repoRead": {
                          "type": "boolean"
                        },
                        "workspaceWrite": {
                          "type": "boolean"
                        },
                        "webAccess": {
                          "type": "boolean"
                        },
                        "requestParticipants": {
                          "type": "string",
                          "enum": [
                            "ask",
                            "allow",
                            "deny"
                          ]
                        },
                        "requestCompaction": {
                          "type": "string",
                          "enum": [
                            "ask",
                            "allow",
                            "deny"
                          ]
                        },
                        "manageRolesParticipants": {
                          "type": "string",
                          "enum": [
                            "ask",
                            "allow",
                            "deny"
                          ],
                          "description": "Member-specific role/member management behavior. Omit to inherit the selected role default."
                        },
                        "shell": {
                          "type": "object",
                          "additionalProperties": false,
                          "properties": {
                            "enabled": {
                              "type": "boolean"
                            },
                            "rules": {
                              "type": "array",
                              "items": {
                                "type": "object",
                                "additionalProperties": false,
                                "properties": {
                                  "action": {
                                    "type": "string",
                                    "enum": [
                                      "allow",
                                      "ask",
                                      "deny"
                                    ]
                                  },
                                  "pattern": {
                                    "type": "string"
                                  },
                                  "match": {
                                    "type": "string",
                                    "enum": [
                                      "exact",
                                      "prefix"
                                    ]
                                  }
                                },
                                "required": [
                                  "action",
                                  "pattern",
                                  "match"
                                ]
                              }
                            }
                          }
                        },
                        "providerNative": {
                          "type": "object",
                          "additionalProperties": true
                        }
                      }
                    }
                  },
                  "required": [
                    "handle",
                    "roleConfigId",
                    "kind"
                  ]
                }
              },
              "required": [
                "type",
                "participant"
              ]
            }
          }
        },
        "required": [
          "operations"
        ]
      },
      "annotations": {
        "readOnlyHint": false,
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false
      }
    },
  }
];

export const APP_MCP_TOOL_POLICIES: readonly AppMcpToolPolicy[] = [...APP_MCP_TOOL_CONTRACTS]
  .sort((left, right) => left.policyOrder - right.policyOrder)
  .map(({ name, capability, effect }) => ({ name, capability, effect }));

export function appMcpToolPoliciesForCapabilities(
  capabilities: ChatAppToolCapability[]
): AppMcpToolPolicy[] {
  return APP_MCP_TOOL_POLICIES.filter(
    (policy) => !policy.capability || hasChatAppToolCapability(capabilities, policy.capability)
  );
}

export function appMcpToolNamesForCapabilities(capabilities: ChatAppToolCapability[]): string[] {
  return appMcpToolPoliciesForCapabilities(capabilities).map((policy) => policy.name);
}

export function autoPreauthorizedAppMcpToolNames(toolNames: string[]): string[] {
  const exposed = new Set(toolNames);
  return APP_MCP_TOOL_POLICIES
    .filter((policy) => policy.effect === "app-managed" && exposed.has(policy.name))
    .map((policy) => policy.name);
}

export function appMcpToolDefinitionsForCapabilities(
  capabilities: ChatAppToolCapability[]
): AppMcpToolDefinition[] {
  return APP_MCP_TOOL_CONTRACTS
    .filter((contract) => !contract.capability || hasChatAppToolCapability(capabilities, contract.capability))
    .map((contract) => ({ name: contract.name, ...contract.desktop }));
}

export function artifactToolDefinitions(): AppMcpToolDefinition[] {
  const artifactNames = new Set<string>(APP_ARTIFACT_TOOL_NAMES);
  return APP_MCP_TOOL_CONTRACTS
    .filter((contract) => artifactNames.has(contract.name))
    .map((contract) => ({ name: contract.name, ...contract.desktop }));
}

export function remoteAppMcpToolContracts(): Array<{
  handler: RemoteAppMcpToolHandler;
  definition: AppMcpToolDefinition;
}> {
  return APP_MCP_TOOL_CONTRACTS
    .filter((contract) => Boolean(contract.worker))
    .sort((left, right) => (left.worker?.order ?? 0) - (right.worker?.order ?? 0))
    .map((contract) => ({
      handler: contract.worker!.handler,
      definition: {
        name: contract.name,
        ...contract.worker!.definition,
        ...(contract.worker!.definition.annotations
          ? {}
          : contract.desktop.annotations ? { annotations: contract.desktop.annotations } : {})
      }
    }));
}

export const REMOTE_APP_MCP_TOOL_NAMES: readonly string[] = remoteAppMcpToolContracts()
  .map((contract) => contract.definition.name);
