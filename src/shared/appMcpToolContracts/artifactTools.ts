import {
  APP_ARTIFACT_CREATE_TOOL, APP_ARTIFACT_DIFF_TOOL, APP_ARTIFACT_LIST_TOOL, APP_ARTIFACT_READ_TOOL, APP_ARTIFACT_RENAME_TOOL,
  APP_ARTIFACT_REVISE_TOOL, APP_ARTIFACT_SET_ACCESS_TOOL, APP_ARTIFACT_SET_ARCHIVED_TOOL, APP_ARTIFACT_SIGN_TOOL
} from "./toolNames";
import type { AppMcpToolContract } from "./types";

/** Documents of the chat. */
export const ARTIFACT_TOOLS: readonly AppMcpToolContract[] = [
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
          "baseVersionEventId": {
            "type": "string",
            "description": "Immutable version identity returned when reading the base revision."
          },
          "baseContentHash": {
            "type": "string",
            "description": "SHA-256 hash of the base revision you read; guards against renumbered offline revisions."
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
          },
          "versionEventId": {
            "type": "string",
            "description": "Immutable version identity returned by app_artifact_read. Send it with contentHash to bind approval to the text you reviewed."
          },
          "contentHash": {
            "type": "string",
            "description": "SHA-256 content hash returned by app_artifact_read; a mismatch rejects the signature."
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
  }
];
