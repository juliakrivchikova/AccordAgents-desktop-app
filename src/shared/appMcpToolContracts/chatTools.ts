import {
  APP_CHAT_EXPORT_ATTACHMENT_TOOL, APP_CHAT_GET_CONTEXT_TOOL, APP_CHAT_GET_PARTICIPANT_ACTIVITY_TOOL,
  APP_CHAT_GET_PARTICIPANT_REQUEST_STATUS_TOOL, APP_CHAT_GET_PARTICIPANTS_TOOL, APP_CHAT_LIST_ATTACHMENTS_TOOL,
  APP_CHAT_REACT_TOOL, APP_CHAT_READ_ATTACHMENT_TOOL, APP_CHAT_READ_MESSAGES_TOOL, APP_CHAT_SEND_MESSAGE_TOOL,
  APP_CHAT_SET_TITLE_TOOL
} from "./toolNames";
import type { AppMcpToolContract } from "./types";

/** Reading the chat and posting into it. */
export const CHAT_TOOLS: readonly AppMcpToolContract[] = [
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
      "description": "Return one authoritative snapshot of every current chat member's roster status, active app-managed work, latest finished message, when it last worked (lastTurnEndedAt, minutesSinceLastTurn) and how full its context is (context). Name members in participants to get only theirs. This is read-only.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "participants": {
            "type": "array",
            "items": { "type": "string" },
            "description": "Optional: only these members (handles, with or without @)."
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
      "description": "Post words authored by you IMMEDIATELY, so other members and User can see them before your turn ends. During your turn, a post for your turn's own place (no other threadId, parentMessageId or chatThreadRootId) shows inside your current reply, in order and above your final answer, like text you write between tool calls; it returns ok, your reply's messageId and sequence, and a postId. A post with accordResolution, into another thread or under another parent, or made when you have no turn running in this chat, is a separate message: it returns that message's messageId and sequence. Use this ONLY when something must be visible mid-turn — for example to publish something others will react to during this same turn (a canonical resolution, sent with accordResolution) and you need its messageId now. Do NOT use this for an ordinary answer or reply: your normal turn response is already shared with everyone when your turn ends, so sending it with this tool just duplicates it and leaves your turn with nothing to say. The returned messageId can be passed to app_chat_react (for a post inside your current reply it is that reply's id, so a reaction goes to your whole reply). Optional image attachments are imported from sourcePath files inside the selected repository when this run has repoRead; v1 accepts only PNG, JPEG, and WebP images.",
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
  }
];
