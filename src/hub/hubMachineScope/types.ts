import type { HubUserApproval } from "../../shared/hubOps";
import type { HubMemberRules } from "../../shared/hubProtocol";
import type {
  ChatAgentMode, ChatAgentPermissions, ChatAppToolApproval, ChatAppToolApprovalPolicy, ChatParticipant,
  ChatParticipantRequestPermission
} from "../../shared/types";

export type Update = { title?: string; repoPath?: string | null; metadata?: Record<string, unknown>; removedMetadataKeys?: string[] };

export interface MachineScopedUpdate {
  update: Update;
  /** What was left out, for the server's log. */
  refused: string[];
  /** What gave a lasting change here (an approval, an `/accord`): each gives
   *  it once, so the server notes it as used (grant keys, grantKey()). */
  used: string[];
}

/** What the machine's write is held to besides the chat itself. */
export interface MachineScopeContext {
  /** What the User approved on the cards this machine raised in the chat. */
  approvals?: HubUserApproval[];
  /** What already gave its lasting change (grant keys). */
  used?: ReadonlySet<string>;
  /** Her rules for members, as her computer last published them. */
  rules?: HubMemberRules;
}

// --- what the User approved ---------------------------------------------------

export interface Approved {
  card: HubUserApproval;
  approval: ChatAppToolApproval;
  /** What she approved: the request as she may have edited it. */
  request: Record<string, unknown>;
  scope: "once" | "chat";
  /** How the server notes it used. */
  key: string;
}

/** Leave to ask other members an `/accord` or an approval gives: the most
 *  it gives, and how the server notes it used. */
export interface Leave {
  cap: ChatParticipantRequestPermission;
  key: string;
}

export type RoleRule = HubMemberRules["roles"][string];

/** A member as an approved addition adds it. */
export interface ApprovedMember {
  /** The approval and its operation: each adds one member. */
  claim: string;
  approval: Approved;
  handle: string;
  /** Its role; `newRole` when the same request makes the role (its id is
   *  given when it is made). */
  roleConfigId?: string;
  newRole?: boolean;
  homeMachineId?: string;
  agentMode: ChatAgentMode;
  permissions: ChatAgentPermissions;
  role?: RoleRule;
}

/** What a machine's member changes are held to, for one write. */
export interface MemberChanges {
  /** The chat's main session as the server has it before this write, when
   *  the chat has one (wherever it runs): what this write may not raise. */
  mainSession?: ChatParticipant;
  machineMembers: ChatParticipant[];
  policies: ChatAppToolApprovalPolicy[];
  approved: Approved[];
  rules: HubMemberRules | undefined;
  /** Approved additions already taken by a member in this write. */
  claimed: Set<string>;
  noted: Set<string>;
}
