import { APP_TOOL_PERMISSION_TOOL } from "./toolNames";
import type { AppMcpToolContract } from "./types";

// Single source of truth for desktop exposure, worker exposure, schemas, and
// Auto preauthorization. Worker entries intentionally retain worker-specific
// descriptions and schemas where their behavior differs from the desktop.
/** Asks the User whether a CLI's tool may run. */
export const PERMISSION_TOOLS: readonly AppMcpToolContract[] = [
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
  }
];
