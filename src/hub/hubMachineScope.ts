/**
 * What a cloud machine may change through the User's server: what concerns
 * the members that run on it, and nothing that would let it reach the
 * members that run elsewhere (the User's computer, another machine) further
 * than a member on the computer reaches them through the app.
 *
 * A machine runs agents with shell access; an agent that was tricked by what
 * it read can read the machine's own key and write to the server directly,
 * around the app. Through the app, a member on a machine changes exactly
 * what a member on the computer changes, under the same rules of the User;
 * these rules make the same hold for a write that goes around it. The server
 * knows which device wrote what, so it holds every machine to them; nothing
 * the machine says about itself counts:
 *
 * - members that run elsewhere stay as the server has them (their
 *   permissions, mode, tools, home), except that `/accord` gives the member
 *   it names leave to ask other members (the main session's, no more than
 *   its own);
 * - a member that runs on the machine stays on it, keeps its role and its
 *   right to manage members, gets leave to ask other members only as the app
 *   gives it (the User's "Allow for this chat" on its request, or `/accord`
 *   naming it), and gets no right or mode beyond what the server has for it
 *   but what the User granted on its permission cards;
 * - a rule that lets a member act without a card ("Allow for this chat") is
 *   added only where the User answered so, for the machine's own members,
 *   and goes with a member removed;
 * - a member is added as the app adds one: by a member there that may manage
 *   members without a card under her rules (her computer publishes them,
 *   HubMemberRules), or as she approved it on a card; in a chat with a main
 *   session, one added without a card has nothing beyond the rights of the
 *   member that added it and of the main session, as the server has them
 *   before the write, wherever it runs;
 * - the chat's project folder and other shared fields are not the machine's
 *   to change; its title only as the app names a new chat (once, by the
 *   member that answers first).
 *
 * A machine asks a member that runs elsewhere (machineMayAsk) as a member
 * asks another through the app: with leave to ask, or with the User's
 * approval of that request.
 *
 * Applied to every machine's `conversation.update` before it is kept, so a
 * machine with an old copy of the chat cannot write other members' old
 * values back either. Pure: the server's copy, what the User approved and
 * her rules in, the change it may make out.
 */

export type { MachineScopedUpdate, MachineScopeContext } from "./hubMachineScope/types";
export { approvalGrantKey, approvedMessageId, keptApproval } from "./hubMachineScope/grants";
export { runsOnMachine } from "./hubMachineScope/records";
export { changesMembers } from "./hubMachineScope/memberChanges";
export { scopeMachineConversationUpdate } from "./hubMachineScope/conversationUpdate";
export { machineMayAsk, machineMayCompact, askNeedsApproval, launchesFacilitator } from "./hubMachineScope/askRights";
