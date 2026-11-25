import {
  APP_PARTICIPANTS_DESCRIBE_OPTIONS_TOOL, APP_PARTICIPANTS_REQUEST_CHANGE_TOOL, APP_ROLES_DESCRIBE_OPTIONS_TOOL,
  APP_ROLES_REQUEST_CHANGE_TOOL, APP_ROSTER_DESCRIBE_OPTIONS_TOOL, APP_ROSTER_REQUEST_CHANGE_TOOL
} from "./toolNames";
import type { AppMcpToolContract } from "./types";

/** Roles and members. */
export const ROSTER_TOOLS: readonly AppMcpToolContract[] = [
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
      "description": "Request adding a new member to the current chat, optionally saving it as a reusable preset, adding an existing saved member preset to the chat, or removing a member from the chat. Removals can be combined with additions (the answer then has additions and removals, status combined, or removal_failed when only the removal failed) and follow the same Manage members policy: with allow a removal is approved without asking (status auto_approved), with ask the User approves it on a card (status pending_user_approval). Either way it is made after your turn ends and no member is running. The Chat Assistant and the last member cannot be removed.",
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
                    "add_existing_participant_to_chat",
                    "remove_participant_from_chat"
                  ]
                },
                "saveAsPreset": {
                  "type": "boolean"
                },
                "participantConfigId": {
                  "type": "string"
                },
                "participantId": {
                  "type": "string",
                  "description": "For remove_participant_from_chat: the current chat member's id. Give this or handle."
                },
                "handle": {
                  "type": "string",
                  "description": "For remove_participant_from_chat: the current chat member's @handle. Give this or participantId."
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
                        "max",
                        "ultra"
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
                        "max",
                        "ultra"
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
