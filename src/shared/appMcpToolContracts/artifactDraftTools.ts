import {
  APP_ARTIFACT_DRAFT_LIST_TOOL, APP_ARTIFACT_DRAFT_READ_TOOL, APP_ARTIFACT_DRAFT_REPLACE_TOOL, APP_ARTIFACT_DRAFT_SAVE_TOOL,
  APP_ARTIFACT_DRAFT_SET_ROSTER_TOOL, APP_ARTIFACT_DRAFT_SUBMIT_TOOL, APP_ARTIFACT_DRAFT_WITHDRAW_TOOL, APP_ARTIFACT_PUBLISH_TOOL
} from "./toolNames";
import type { AppMcpToolContract } from "./types";

/** Drafts of documents, and publishing them. */
export const ARTIFACT_DRAFT_TOOLS: readonly AppMcpToolContract[] = [
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
  }
];
