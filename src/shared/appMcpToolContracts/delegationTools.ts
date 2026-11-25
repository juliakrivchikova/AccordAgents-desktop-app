import { APP_CHAT_DELEGATE_TASK_TOOL, APP_CHAT_START_ACCORD_TOOL } from "./toolNames";
import type { AppMcpToolContract } from "./types";

/** New members and Accords. */
export const DELEGATION_TOOLS: readonly AppMcpToolContract[] = [
  {
    // The main session's own (docs/main-session.md): only the chat's main
    // session gets participants.delegate.
    name: APP_CHAT_DELEGATE_TASK_TOOL,
    policyOrder: 48,
    effect: "app-managed",
    capability: "participants.delegate",
    desktop: {
      "title": "Delegate a Task to a New Member",
      "description": "Create a new member of this chat and give it a task in the same call; the app adds it without asking User and starts it at once. Returns at once with status running; the member's reply comes back to you in a fresh turn, so end your turn or continue other work. start \"clean\" (default): a new session that sees nothing but the task, so the task must be a complete brief (goal, context, constraints, what to report back). start \"fork\": a copy of your own CLI session, so the member knows this conversation; possible only for your own provider (Claude Code or Codex) on the same machine. When a fork is not possible the call returns ok false with code fork_unavailable; then start a clean member and put what it needs from this conversation into the task. The member gets your provider, model, mode and machine unless you name others, and never broader permissions than yours.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "title": {
            "type": "string",
            "description": "A short title for the task, 2 to 6 words in User's language, the way a chat thread is titled (for example \"Check the server logs\"). User sees the member by this title, not by its handle."
          },
          "task": {
            "type": "string",
            "description": "The member's task: everything it needs to do the work and what to report back."
          },
          "start": {
            "type": "string",
            "enum": ["clean", "fork"],
            "description": "clean (default): a new session with only the task. fork: a copy of your own session."
          },
          "handle": {
            "type": "string",
            "description": "Optional member name without @ (letters, numbers, _ and -). When taken, a free name close to it is used."
          },
          "roleConfigId": {
            "type": "string",
            "description": "Optional role id (app_participants_describe_options); defaults to the generic member role. Not the main session or Chat Assistant role."
          },
          "kind": {
            "type": "string",
            "enum": ["claude-code", "codex-cli", "gemini-cli"],
            "description": "Optional CLI provider; defaults to yours."
          },
          "model": {
            "type": "string",
            "description": "Optional model id; defaults to yours for your own provider and to the provider's default for another."
          },
          "reasoningEffort": {
            "type": "string",
            "enum": ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
          },
          "agentMode": {
            "type": "string",
            "enum": ["default", "plan", "auto"],
            "description": "Optional; defaults to yours and is never above yours."
          },
          "permissions": {
            "type": "object",
            "additionalProperties": false,
            "description": "Optional rights for the member; what you leave out is yours. Anything broader than yours is left out.",
            "properties": {
              "repoRead": { "type": "boolean" },
              "workspaceWrite": { "type": "boolean" },
              "webAccess": { "type": "boolean" },
              "requestParticipants": { "type": "string", "enum": ["ask", "allow", "deny"] },
              "requestCompaction": { "type": "string", "enum": ["ask", "allow", "deny"] },
              "manageRolesParticipants": {
                "type": "string",
                "enum": ["ask", "allow", "deny"],
                "description": "Only when the task is to manage members; otherwise the member does not add members."
              },
              "shell": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "enabled": { "type": "boolean" },
                  "rules": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "additionalProperties": false,
                      "properties": {
                        "action": { "type": "string", "enum": ["allow", "ask", "deny"] },
                        "pattern": { "type": "string" },
                        "match": { "type": "string", "enum": ["exact", "prefix"] }
                      },
                      "required": ["action", "pattern", "match"]
                    }
                  }
                }
              },
              "providerNative": {
                "type": "object",
                "additionalProperties": true
              }
            }
          },
          "reason": {
            "type": "string",
            "description": "Optional one line on why this member is needed."
          }
        },
        "required": ["title", "task"]
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
    // The main session's own: only it starts an Accord (docs/main-session.md).
    name: APP_CHAT_START_ACCORD_TOOL,
    policyOrder: 49,
    effect: "app-managed",
    capability: "accord.start",
    desktop: {
      "title": "Start an Accord",
      "description": "Start an Accord: the facilitator runs the /accord skill with the named members on the subject until they agree on one resolution. The launch is posted in the chat as yours. The facilitator defaults to you; it may ask the named members without asking User, never with broader rights than yours. Returns at once; the Accord's progress shows in the chat.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "targets": {
            "type": "array",
            "minItems": 1,
            "items": { "type": "string" },
            "description": "Handles of the members who take part (with or without @), not the facilitator."
          },
          "subject": {
            "type": "string",
            "description": "What the Accord decides, with the context the members need."
          },
          "facilitator": {
            "type": "string",
            "description": "Optional facilitator handle; defaults to you."
          }
        },
        "required": ["targets", "subject"]
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
