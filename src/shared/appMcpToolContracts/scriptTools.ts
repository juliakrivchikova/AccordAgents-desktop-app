import { APP_SCRIPTS_LIST_TOOL, APP_SCRIPTS_READ_RUNS_TOOL, APP_SCRIPTS_REQUEST_CHANGE_TOOL } from "./toolNames";
import type { AppMcpToolContract } from "./types";

/** Scheduled tasks. */
export const SCRIPT_TOOLS: readonly AppMcpToolContract[] = [
  {
    name: APP_SCRIPTS_REQUEST_CHANGE_TOOL,
    policyOrder: 38,
    effect: "app-managed",
    desktop: {
      "title": "Request Scheduled Task Change",
      "description": "Propose a scheduled task (the User's name for it; say scheduled task to the User): a small node or bash script the app runs on a schedule (an interval, or a cron expression in the User's time zone) and that can wake chat members by posting into existing chats through the local script API. Follow the automations skill. Every create/update/delete/enable/disable shows the User an approval card (code, schedule, chats, members, keys) and nothing runs until the User approves, except that a create is added and switched on at once when your access says the User lets you create scheduled tasks without a card and it needs no keys. Key values (API tokens) are entered by the User on the card and you never see them; name them in secretNames and read them from environment variables. run_now starts an approved, switched-on script once without a card. Returns status pending_user_approval with approvalId and scriptId, created for a task created without a card, or started for run_now.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "op": { "type": "string", "enum": ["create", "update", "delete", "enable", "disable", "run_now"] },
          "scriptId": { "type": "string", "description": "Required for every op except create." },
          "name": { "type": "string", "description": "Short name shown to the User, e.g. \"Grafana alert watcher\". Required for create." },
          "description": { "type": "string", "description": "What the script does, in plain words for the User. Required for create." },
          "runtime": { "type": "string", "enum": ["node", "bash"] },
          "entry": { "type": "string", "description": "The file to run; defaults to the first file." },
          "files": {
            "type": "array",
            "description": "The script's files, at most 64 KB in total. Omit on update to keep the approved files.",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "path": { "type": "string", "description": "Relative path, e.g. watch.mjs" },
                "content": { "type": "string" }
              },
              "required": ["path", "content"]
            }
          },
          "schedule": {
            "type": "object",
            "description": "{\"kind\":\"interval\",\"everySeconds\":60} (at least 60) or {\"kind\":\"cron\",\"expression\":\"0 17 * * 1-5\",\"timeZone\":\"Europe/Berlin\"}.",
            "additionalProperties": false,
            "properties": {
              "kind": { "type": "string", "enum": ["interval", "cron"] },
              "everySeconds": { "type": "integer", "minimum": 60 },
              "expression": { "type": "string" },
              "timeZone": { "type": "string", "description": "IANA time zone of the User." }
            },
            "required": ["kind"]
          },
          "timeoutSeconds": { "type": "integer", "minimum": 10, "maximum": 3600, "description": "Default 300." },
          "secretNames": { "type": "array", "items": { "type": "string" }, "description": "Names of keys the User enters on the card, UPPER_SNAKE_CASE, e.g. SLACK_BOT_TOKEN. The script reads them from its environment." },
          "chatIds": { "type": "array", "items": { "type": "string" }, "description": "Existing chats the script may post into. Defaults to this chat." },
          "members": { "type": "array", "items": { "type": "string" }, "description": "Handles of members the script may mention (and so start), e.g. [\"@taylor\"]." },
          "maxWakeupsPerHour": { "type": "integer", "minimum": 1, "maximum": 60, "description": "Messages that mention someone per rolling hour; extra ones are held for the User. Default 6." },
          "reason": { "type": "string", "description": "Why, for the User." }
        },
        "required": ["op"]
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
    name: APP_SCRIPTS_LIST_TOOL,
    policyOrder: 39,
    effect: "app-managed",
    desktop: {
      "title": "List Scheduled Tasks",
      "description": "List the scheduled tasks on this host with their schedule, status (ok, failing, blocked, off, needs-approval, waiting-for-keys, holding-messages), last and next run, chats, members and which keys are saved. Never returns key values or code.",
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
    name: APP_SCRIPTS_READ_RUNS_TOOL,
    policyOrder: 40,
    effect: "app-managed",
    desktop: {
      "title": "Read Scheduled Task Runs",
      "description": "Read a scheduled task's run history, newest first: status, how many consecutive runs a row covers, exit code, messages sent, and the last output (key values are replaced by •••). Use it to explain why a task is failing.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "scriptId": { "type": "string" },
          "limit": { "type": "integer", "minimum": 1, "maximum": 100 }
        },
        "required": ["scriptId"]
      },
      "annotations": {
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false
      }
    },
  }
];
