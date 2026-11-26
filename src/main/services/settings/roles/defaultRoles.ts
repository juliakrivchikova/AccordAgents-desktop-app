import { MAIN_SESSION_ROLE_ID } from "../../../../shared/mainSession";
import type { ChatAppToolCapability, ChatRoleConfig, ChatRoleParticipantDefaults } from "../../../../shared/types";
import { DEFAULT_ROLE_PARTICIPANT_DEFAULTS, GENERIC_PARTICIPANT_ROLE_ID, WORKFLOW_MANAGER_ROLE_ID } from "./roleIds";
import { DEFAULT_ARBITER_INSTRUCTIONS, DEFAULT_SYNTHESIZER_INSTRUCTIONS } from "./texts/accord";
import {
  DEFAULT_ADMINISTRATOR_INSTRUCTIONS, DEFAULT_GENERIC_PARTICIPANT_INSTRUCTIONS, DEFAULT_MAIN_SESSION_INSTRUCTIONS,
  DEFAULT_WORKFLOW_MANAGER_INSTRUCTIONS
} from "./texts/administrator";
import {
  DEFAULT_CODE_REVIEWER_INSTRUCTIONS, DEFAULT_DEBUGGER_INSTRUCTIONS, DEFAULT_DEVEX_REVIEWER_INSTRUCTIONS,
  DEFAULT_ENGINEERING_MANAGER_INSTRUCTIONS, DEFAULT_QA_LEAD_INSTRUCTIONS, DEFAULT_RELEASE_ENGINEER_INSTRUCTIONS,
  DEFAULT_SECURITY_REVIEWER_INSTRUCTIONS, DEFAULT_SOFTWARE_ENGINEER_INSTRUCTIONS
} from "./texts/engineering";
import {
  DEFAULT_BRAND_STRATEGIST_INSTRUCTIONS, DEFAULT_DOMAIN_SEO_SPECIALIST_INSTRUCTIONS, DEFAULT_NAMING_CONSULTANT_INSTRUCTIONS,
  DEFAULT_PRODUCT_DESIGNER_INSTRUCTIONS, DEFAULT_PRODUCT_MARKETER_INSTRUCTIONS, DEFAULT_PRODUCT_STRATEGIST_INSTRUCTIONS,
  DEFAULT_TRADEMARK_ATTORNEY_INSTRUCTIONS, DEFAULT_UX_CONTENT_STRATEGIST_INSTRUCTIONS
} from "./texts/product";

export const DEFAULT_CHAT_ROLES: ChatRoleConfig[] = [
  {
    id: MAIN_SESSION_ROLE_ID,
    label: "Main session",
    instructions: DEFAULT_MAIN_SESSION_INSTRUCTIONS,
    version: 4,
    builtIn: true,
    appToolCapabilities: ["participants.manage", "participants.delegate", "accord.start"] satisfies ChatAppToolCapability[],
    participantDefaults: {
      ...DEFAULT_ROLE_PARTICIPANT_DEFAULTS,
      requestParticipants: "allow",
      manageRolesParticipants: "allow"
    } satisfies ChatRoleParticipantDefaults,
    updatedAt: "2026-11-26T00:00:00.000Z"
  },
  {
    id: "administrator",
    label: "Chat Assistant",
    instructions: DEFAULT_ADMINISTRATOR_INSTRUCTIONS,
    version: 14,
    builtIn: true,
    appToolCapabilities: ["participants.manage"] satisfies ChatAppToolCapability[],
    participantDefaults: {
      ...DEFAULT_ROLE_PARTICIPANT_DEFAULTS,
      manageRolesParticipants: "ask"
    } satisfies ChatRoleParticipantDefaults,
    updatedAt: "2026-10-30T00:00:00.000Z"
  },
  {
    id: GENERIC_PARTICIPANT_ROLE_ID,
    label: "Generic Member",
    instructions: DEFAULT_GENERIC_PARTICIPANT_INSTRUCTIONS,
    version: 1,
    builtIn: true,
    updatedAt: "2026-06-14T00:00:00.000Z"
  },
  {
    id: "synthesizer",
    label: "Synthesizer",
    instructions: DEFAULT_SYNTHESIZER_INSTRUCTIONS,
    version: 5,
    builtIn: true,
    updatedAt: "2026-05-10T00:00:00.000Z"
  },
  {
    id: "arbiter",
    label: "Arbiter",
    instructions: DEFAULT_ARBITER_INSTRUCTIONS,
    version: 6,
    builtIn: true,
    updatedAt: "2026-05-17T00:00:00.000Z"
  },
  {
    id: "software-engineer",
    label: "Software Engineer",
    instructions: DEFAULT_SOFTWARE_ENGINEER_INSTRUCTIONS,
    version: 6,
    builtIn: true,
    updatedAt: "2026-09-06T00:00:00.000Z"
  },
  {
    id: "product-strategist",
    label: "Product Strategist",
    instructions: DEFAULT_PRODUCT_STRATEGIST_INSTRUCTIONS,
    version: 1,
    builtIn: true,
    updatedAt: "2026-05-10T00:00:00.000Z"
  },
  {
    id: "brand-strategist",
    label: "Brand Strategist",
    instructions: DEFAULT_BRAND_STRATEGIST_INSTRUCTIONS,
    version: 1,
    builtIn: true,
    updatedAt: "2026-05-15T00:00:00.000Z"
  },
  {
    id: "naming-consultant",
    label: "Naming Consultant",
    instructions: DEFAULT_NAMING_CONSULTANT_INSTRUCTIONS,
    version: 1,
    builtIn: true,
    updatedAt: "2026-05-15T00:00:00.000Z"
  },
  {
    id: "product-marketer",
    label: "Product Marketer",
    instructions: DEFAULT_PRODUCT_MARKETER_INSTRUCTIONS,
    version: 1,
    builtIn: true,
    updatedAt: "2026-05-15T00:00:00.000Z"
  },
  {
    id: "ux-content-strategist",
    label: "UX Content Strategist",
    instructions: DEFAULT_UX_CONTENT_STRATEGIST_INSTRUCTIONS,
    version: 1,
    builtIn: true,
    updatedAt: "2026-05-15T00:00:00.000Z"
  },
  {
    id: "trademark-attorney",
    label: "Trademark Attorney",
    instructions: DEFAULT_TRADEMARK_ATTORNEY_INSTRUCTIONS,
    version: 1,
    builtIn: true,
    updatedAt: "2026-05-15T00:00:00.000Z"
  },
  {
    id: "domain-seo-specialist",
    label: "Domain & SEO Specialist",
    instructions: DEFAULT_DOMAIN_SEO_SPECIALIST_INSTRUCTIONS,
    version: 1,
    builtIn: true,
    updatedAt: "2026-05-15T00:00:00.000Z"
  },
  {
    id: "engineering-manager",
    label: "Engineering Manager",
    instructions: DEFAULT_ENGINEERING_MANAGER_INSTRUCTIONS,
    version: 1,
    builtIn: true,
    updatedAt: "2026-05-10T00:00:00.000Z"
  },
  {
    id: "product-designer",
    label: "Product Designer",
    instructions: DEFAULT_PRODUCT_DESIGNER_INSTRUCTIONS,
    version: 1,
    builtIn: true,
    updatedAt: "2026-05-10T00:00:00.000Z"
  },
  {
    id: "devex-reviewer",
    label: "Developer Experience Reviewer",
    instructions: DEFAULT_DEVEX_REVIEWER_INSTRUCTIONS,
    version: 1,
    builtIn: true,
    updatedAt: "2026-05-10T00:00:00.000Z"
  },
  {
    id: "debugger",
    label: "Debugger",
    instructions: DEFAULT_DEBUGGER_INSTRUCTIONS,
    version: 1,
    builtIn: true,
    updatedAt: "2026-05-10T00:00:00.000Z"
  },
  {
    id: "qa-lead",
    label: "QA Lead",
    instructions: DEFAULT_QA_LEAD_INSTRUCTIONS,
    version: 1,
    builtIn: true,
    updatedAt: "2026-05-10T00:00:00.000Z"
  },
  {
    id: "security-reviewer",
    label: "Security Reviewer",
    instructions: DEFAULT_SECURITY_REVIEWER_INSTRUCTIONS,
    version: 1,
    builtIn: true,
    updatedAt: "2026-05-10T00:00:00.000Z"
  },
  {
    id: "release-engineer",
    label: "Release Engineer",
    instructions: DEFAULT_RELEASE_ENGINEER_INSTRUCTIONS,
    version: 1,
    builtIn: true,
    updatedAt: "2026-05-10T00:00:00.000Z"
  },
  {
    id: "code-reviewer",
    label: "Code Reviewer",
    instructions: DEFAULT_CODE_REVIEWER_INSTRUCTIONS,
    version: 1,
    builtIn: true,
    updatedAt: "2026-05-10T00:00:00.000Z"
  },
  {
    id: WORKFLOW_MANAGER_ROLE_ID,
    label: "Workflow Manager",
    instructions: DEFAULT_WORKFLOW_MANAGER_INSTRUCTIONS,
    version: 5,
    builtIn: true,
    participantDefaults: {
      ...DEFAULT_ROLE_PARTICIPANT_DEFAULTS,
      autoWatch: true,
      requestParticipants: "allow",
      manageRolesParticipants: "allow"
    } satisfies ChatRoleParticipantDefaults,
    updatedAt: "2026-07-08T00:00:00.000Z"
  }
].map((role) => ({
  participantDefaults: { ...DEFAULT_ROLE_PARTICIPANT_DEFAULTS },
  ...role
}));

/** The ids of the app's own roles (the usage signals name only these). */
export const BUILTIN_CHAT_ROLE_IDS: readonly string[] = DEFAULT_CHAT_ROLES.map((role) => role.id);

/** The role the app gives a member it adds on its own (a role other than
 *  this one, or the Assistant's, is a role someone chose). */
export const DEFAULT_MEMBER_ROLE_ID = GENERIC_PARTICIPANT_ROLE_ID;
