// GENERATED FILE — do not edit. Source: src/shared/appMcpToolContracts.ts
// Regenerate after build: npm run build:main && node scripts/generate-app-mcp-worker-contract.mjs

export const REMOTE_APP_MCP_TOOL_CONTRACTS = [
  {
    "handler": "permissions-request",
    "definition": {
      "name": "app_permissions_request_change",
      "title": "Request Permission Change",
      "description": "Queue a permission request for desktop approval when the desktop reconnects. Supports portable, shellRules, providerNative, and githubApp request kinds.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": true
      },
      "annotations": {
        "readOnlyHint": false,
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false
      }
    }
  },
  {
    "handler": "chat-get-context",
    "definition": {
      "name": "app_chat_get_context",
      "title": "Get Chat Context Snapshot",
      "description": "Read the run-start chat context snapshot stored on the worker.",
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
    }
  },
  {
    "handler": "chat-get-participants",
    "definition": {
      "name": "app_chat_get_participants",
      "title": "Get Chat Members Snapshot",
      "description": "Read member data from the run-start context snapshot.",
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
    }
  },
  {
    "handler": "chat-read-messages",
    "definition": {
      "name": "app_chat_read_messages",
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
      },
      "annotations": {
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false
      }
    }
  },
  {
    "handler": "chat-send-message",
    "definition": {
      "name": "app_chat_send_message",
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
      },
      "annotations": {
        "readOnlyHint": false,
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false
      }
    }
  },
  {
    "handler": "chat-list-attachments",
    "definition": {
      "name": "app_chat_list_attachments",
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
      },
      "annotations": {
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false
      }
    }
  },
  {
    "handler": "chat-read-attachment",
    "definition": {
      "name": "app_chat_read_attachment",
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
      },
      "annotations": {
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false
      }
    }
  }
] as const;

export const REMOTE_APP_MCP_WORKER_CONTRACT_SNIPPET: string = "const REMOTE_APP_MCP_TOOL_CONTRACTS = [\n  {\n    \"handler\": \"permissions-request\",\n    \"definition\": {\n      \"name\": \"app_permissions_request_change\",\n      \"title\": \"Request Permission Change\",\n      \"description\": \"Queue a permission request for desktop approval when the desktop reconnects. Supports portable, shellRules, providerNative, and githubApp request kinds.\",\n      \"inputSchema\": {\n        \"type\": \"object\",\n        \"additionalProperties\": true\n      },\n      \"annotations\": {\n        \"readOnlyHint\": false,\n        \"destructiveHint\": false,\n        \"idempotentHint\": false,\n        \"openWorldHint\": false\n      }\n    }\n  },\n  {\n    \"handler\": \"chat-get-context\",\n    \"definition\": {\n      \"name\": \"app_chat_get_context\",\n      \"title\": \"Get Chat Context Snapshot\",\n      \"description\": \"Read the run-start chat context snapshot stored on the worker.\",\n      \"inputSchema\": {\n        \"type\": \"object\",\n        \"additionalProperties\": false,\n        \"properties\": {}\n      },\n      \"annotations\": {\n        \"readOnlyHint\": true,\n        \"destructiveHint\": false,\n        \"idempotentHint\": true,\n        \"openWorldHint\": false\n      }\n    }\n  },\n  {\n    \"handler\": \"chat-get-participants\",\n    \"definition\": {\n      \"name\": \"app_chat_get_participants\",\n      \"title\": \"Get Chat Members Snapshot\",\n      \"description\": \"Read member data from the run-start context snapshot.\",\n      \"inputSchema\": {\n        \"type\": \"object\",\n        \"additionalProperties\": false,\n        \"properties\": {}\n      },\n      \"annotations\": {\n        \"readOnlyHint\": true,\n        \"destructiveHint\": false,\n        \"idempotentHint\": true,\n        \"openWorldHint\": false\n      }\n    }\n  },\n  {\n    \"handler\": \"chat-read-messages\",\n    \"definition\": {\n      \"name\": \"app_chat_read_messages\",\n      \"title\": \"Read Chat Messages\",\n      \"description\": \"Read paginated chat messages from the run-start snapshot, optionally filtered to one thread or one message id. Same result shape as the desktop tool. The window is fixed at run start: messages posted after this run began are not in it, and the page counts describe the snapshot, not the live conversation.\",\n      \"inputSchema\": {\n        \"type\": \"object\",\n        \"additionalProperties\": false,\n        \"properties\": {\n          \"messageId\": {\n            \"type\": \"string\"\n          },\n          \"threadId\": {\n            \"type\": \"string\"\n          },\n          \"beforeSequence\": {\n            \"type\": \"integer\",\n            \"minimum\": 0\n          },\n          \"afterSequence\": {\n            \"type\": \"integer\",\n            \"minimum\": 0\n          },\n          \"limit\": {\n            \"type\": \"integer\",\n            \"minimum\": 1,\n            \"maximum\": 200\n          }\n        }\n      },\n      \"annotations\": {\n        \"readOnlyHint\": true,\n        \"destructiveHint\": false,\n        \"idempotentHint\": true,\n        \"openWorldHint\": false\n      }\n    }\n  },\n  {\n    \"handler\": \"chat-send-message\",\n    \"definition\": {\n      \"name\": \"app_chat_send_message\",\n      \"title\": \"Post A Message Mid-Run\",\n      \"description\": \"Post a message to the chat while this run is still working. The post is queued on the worker and appears when the desktop next drains this run, so it is not instant and returns no message id. Text only.\",\n      \"inputSchema\": {\n        \"type\": \"object\",\n        \"additionalProperties\": false,\n        \"required\": [\n          \"content\"\n        ],\n        \"properties\": {\n          \"content\": {\n            \"type\": \"string\"\n          }\n        }\n      },\n      \"annotations\": {\n        \"readOnlyHint\": false,\n        \"destructiveHint\": false,\n        \"idempotentHint\": false,\n        \"openWorldHint\": false\n      }\n    }\n  },\n  {\n    \"handler\": \"chat-list-attachments\",\n    \"definition\": {\n      \"name\": \"app_chat_list_attachments\",\n      \"title\": \"List Chat Image Attachments\",\n      \"description\": \"List image attachments visible in the run-start snapshot, oldest first. Use this for attachment ids, then app_chat_read_attachment to see one.\",\n      \"inputSchema\": {\n        \"type\": \"object\",\n        \"additionalProperties\": false,\n        \"properties\": {\n          \"messageId\": {\n            \"type\": \"string\"\n          },\n          \"threadId\": {\n            \"type\": \"string\"\n          },\n          \"limit\": {\n            \"type\": \"integer\",\n            \"minimum\": 1,\n            \"maximum\": 50\n          }\n        }\n      },\n      \"annotations\": {\n        \"readOnlyHint\": true,\n        \"destructiveHint\": false,\n        \"idempotentHint\": true,\n        \"openWorldHint\": false\n      }\n    }\n  },\n  {\n    \"handler\": \"chat-read-attachment\",\n    \"definition\": {\n      \"name\": \"app_chat_read_attachment\",\n      \"title\": \"Read Chat Image Attachment\",\n      \"description\": \"Read one image attachment bundled with this run and return it as image content. Only attachments visible at run start are available.\",\n      \"inputSchema\": {\n        \"type\": \"object\",\n        \"additionalProperties\": false,\n        \"required\": [\n          \"attachmentId\"\n        ],\n        \"properties\": {\n          \"attachmentId\": {\n            \"type\": \"string\"\n          }\n        }\n      },\n      \"annotations\": {\n        \"readOnlyHint\": true,\n        \"destructiveHint\": false,\n        \"idempotentHint\": true,\n        \"openWorldHint\": false\n      }\n    }\n  }\n];\nconst REMOTE_APP_MCP_TOOL_HANDLER_BY_NAME = Object.fromEntries(\n  REMOTE_APP_MCP_TOOL_CONTRACTS.map((contract) => [contract.definition.name, contract.handler])\n);";
