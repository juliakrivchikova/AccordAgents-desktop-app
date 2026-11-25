import {
  APP_CHAT_REQUEST_COMPACTION_TOOL, APP_CHAT_REQUEST_PARTICIPANTS_TOOL, APP_CONNECTOR_SIGN_IN_TOOL,
  APP_PERMISSIONS_REQUEST_CHANGE_TOOL
} from "./toolNames";
import type { AppMcpToolContract } from "./types";

/** Asking other members, compaction, sign-in and more rights. */
export const MEMBER_REQUEST_TOOLS: readonly AppMcpToolContract[] = [
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
            "description": "Only with resumeRequester false: how long to wait for inline replies. Defaults to 120000ms."
          },
          "resumeRequester": {
            "type": "boolean",
            "description": "Defaults to true: the call returns at once and replies arrive in a fresh requester turn. Set false to wait for completed replies inline."
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
      "description": "Compact your own context: it runs right after your current reply ends, and then the app calls you again to go on with your work, so nobody has to call you. Good moments: before a new task, before the next stage of a big task, whenever most of your context is no longer needed. End your reply after a queued or pending_user_approval result. The app validates permission, active-session status, duplicate requests, and cooldown. instructions name what the summary must keep.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "instructions": {
            "type": "string",
            "description": "What the summary must keep for the work that comes next: the goal and the User's decisions, where things stand, the next step."
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
    name: APP_CONNECTOR_SIGN_IN_TOOL,
    policyOrder: 46,
    effect: "app-managed",
    capability: "permissions.request",
    desktop: {
      "title": "Ask the User to Sign In to a Connector",
      "description": "Ask the User to sign in to an MCP server or claude.ai connector your task needs that is not connected (it needs authentication, or it failed to connect). The User gets a sign-in card; the call waits until they finish, then reconnects the server, so once it returns connected the server's tools are available in this same reply (find them with ToolSearch). Pass the server's name as Claude Code lists it, for example \"claude.ai Sentry\". Returns connected, declined, not_found with similar names, or the CLI's own error. Works for Claude Code members.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["connector"],
        "properties": {
          "connector": {
            "type": "string",
            "description": "The MCP server's name as Claude Code lists it, for example \"claude.ai Sentry\"."
          },
          "reason": {
            "type": "string",
            "description": "One short sentence on what you need it for; the card shows it."
          }
        }
      },
      "annotations": {
        "readOnlyHint": false,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": true
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
  }
];
