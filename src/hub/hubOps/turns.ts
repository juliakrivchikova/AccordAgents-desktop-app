import { isMemberRestartTurnRequest } from "../../shared/memberRestart";
import { isMemberSessionExportTurnRequest } from "../../shared/memberSessionMove";
import { claimOutcomeFor } from "../../main/services/hubOpsStore";
import { askNeedsApproval, launchesFacilitator, machineMayAsk, machineMayCompact, runsOnMachine } from "../hubMachineScope";
import type { HubDevice } from "../../shared/hubProtocol";
import { chatViewFor } from "../../shared/mainSession";
import type { HubFeedEntry, HubOp, HubOpEffect, HubOpResult, HubTurn } from "../../shared/hubOps";
import type { Conversation } from "../../shared/types";
import { contentHash, homeDeviceId, reject } from "./chatRecords";
import type { Outcome } from "./types";
import type { HubOpsModules } from "./modules";
import type { HubOpsDependencies } from "./dependencies";

/** Turns members are asked for. */
export class Turns {
  constructor(
    private readonly ops: Pick<HubOpsModules, "chatCache" | "memberRules">,
    private readonly deps: Pick<HubOpsDependencies, "storage">
  ) {}

  async applyTurn(
    device: HubDevice,
    op: Extract<HubOp, { kind: "turn.request" | "turn.claim" | "turn.stop" | "turn.finish" }>,
    devices: HubDevice[],
    place: { opId: string; seq: number; acceptedAt: string }
  ): Promise<Outcome> {
    const store = this.deps.storage.hubOps();
    const { opId, seq, acceptedAt } = place;
    const current = await store.turn(op.runId);
    const head = seq - 1;
    // Nothing changes: the device hears where the turn stands; nothing is placed.
    const unchanged = (claim?: ReturnType<typeof claimOutcomeFor>) => ({
      result: { opId, status: "accepted" as const, seq: head, ...(claim ? { claim } : {}), ...(current ? { turn: current } : {}) }
    });
    const place_ = async (turn: HubTurn, claim?: ReturnType<typeof claimOutcomeFor>, alsoSql = ""): Promise<Outcome> => {
      const effect: HubOpEffect = { kind: op.kind, turn } as HubOpEffect;
      const result: HubOpResult = { opId, status: "accepted", seq, ...(claim ? { claim } : {}), turn };
      const entry: HubFeedEntry = { seq, opId, deviceId: device.deviceId, conversationId: op.conversationId, acceptedAt, effect };
      await store.execute(`${store.turnSql(turn)} ${alsoSql} ${store.insertSql({ ...entry, kind: op.kind, result })}`);
      return { result, applied: { deviceId: device.deviceId, entry } };
    };

    if (op.kind === "turn.finish") {
      if (!current || current.executorDeviceId !== device.deviceId) return reject(opId, "Only the device that took this turn may finish it.");
      if (current.state === "finished") return unchanged("finished");
      return place_({ ...current, state: "finished", finishedAt: acceptedAt, outcome: op.outcome, ...(op.contextUsage ? { contextUsage: op.contextUsage } : {}) });
    }

    const conversation = await this.ops.chatCache.load(op.conversationId);
    if (!conversation) return reject(opId, "There is no such chat.");
    if (current && (current.conversationId !== op.conversationId || current.messageId !== op.messageId || current.participantId !== op.participantId)) {
      return reject(opId, "This turn belongs to another message.");
    }

    if (op.kind === "turn.stop") {
      if (!current) {
        return place_({ runId: op.runId, conversationId: op.conversationId, messageId: op.messageId, participantId: op.participantId,
          state: "stopped", finishedAt: acceptedAt, outcome: "stopped" });
      }
      // Asked for and not taken yet: nobody ever takes it.
      if (current.state === "requested") return place_({ ...current, state: "stopped", finishedAt: acceptedAt, outcome: "stopped" });
      if (current.state !== "claimed" || current.stopRequestedAt) return unchanged();
      return place_({ ...current, stopRequestedAt: acceptedAt });
    }

    const trigger = conversation.messages.find((message) => message.id === op.messageId);
    if (!trigger) return reject(opId, "There is no such message.");
    // In the sessions view a mention in a member's reply starts nobody
    // (docs/main-session.md): a new turn for a message its device labelled an
    // inferred request (`source: "inferred"`) is refused, whichever device
    // asks for it (a cloud machine on an older program included). The server
    // trusts that label as the device wrote it: a device that leaves it off,
    // or starts the member some other way, is not stopped here. A turn
    // already asked for stands.
    if (!current && chatViewFor(conversation.metadata) === "sessions" && trigger.metadata?.participantRequest?.source === "inferred") {
      return reject(opId, "In the sessions view a mention in a member's reply starts nobody.");
    }
    const home = homeDeviceId(conversation, op.participantId, devices);
    if (!home) return reject(opId, "This member is not in the chat, or its machine is not on the server's roster.");

    if (op.kind === "turn.request") {
      // Any device asks; the member's own device takes it (Д2, Д4).
      if (current) return unchanged(claimOutcomeFor(current, device.deviceId));
      // A member's session leaves its device only when the computer moves
      // the member: never at a machine's or a phone's word.
      if (isMemberSessionExportTurnRequest(op.request) && device.role !== "owner" && device.role !== "desktop") {
        return reject(opId, "Only the computer moves a member with its session.");
      }
      // A phone or a machine never asks a turn of a machine whose program
      // would run the member's mode otherwise than its controls say (the
      // computer refuses its own: it knows each machine's program first).
      // Any request that runs the member: all but a compaction, a restart and
      // a move of its session (a kind the server does not know included).
      const runsMember = op.request?.kind !== "compaction" && !isMemberRestartTurnRequest(op.request) && !isMemberSessionExportTurnRequest(op.request);
      if ((device.role === "phone" || device.role === "machine") && runsMember) {
        const modes = await this.ops.memberRules.cliModesRefusal(conversation, [op.participantId], devices);
        if (modes) return reject(opId, modes);
      }
      // A machine asks a member that runs elsewhere as a member asks another
      // through the app: to answer one of its own members' messages, never
      // the User's words and never to compact it.
      let askGrant = "";
      if (device.role === "machine") {
        const members = Array.isArray(conversation.metadata?.participants) ? conversation.metadata.participants as Array<{ id?: unknown; homeMachineId?: string }> : [];
        const member = (id: unknown) => members.find((item) => item?.id === id);
        const elsewhere = !runsOnMachine(member(op.participantId), device.machineId);
        // The chat's main session on this machine compacts any member, one
        // that runs elsewhere too, as the computer may, while it compacts
        // without asking; a compaction that names it otherwise is refused,
        // so the line never says it compacted a member when it did not.
        const namesMain = op.request?.kind === "compaction" && op.request.requestedByParticipantId !== undefined;
        if (namesMain && !machineMayCompact(conversation, device.machineId, op.participantId, op.request)) {
          return reject(opId, "Only the chat's main session on this machine compacts other members, and only while it compacts without asking.");
        }
        if (elsewhere && !namesMain) {
          const message = conversation.messages.find((item) => item.id === op.messageId);
          const ownMembers = message?.role === "participant" && runsOnMachine(member(message.participantId), device.machineId);
          if (!ownMembers || op.request?.kind === "compaction" || isMemberRestartTurnRequest(op.request)) {
            return reject(opId, "A cloud machine asks a member that runs elsewhere only to answer a message of one of its own members.");
          }
          // The facilitator of an Accord its member started with the app
          // tool runs as the app runs it, at once and once.
          const launched = launchesFacilitator(conversation, message!, op.participantId, await this.ops.memberRules.memberRules(),
            await store.usedGrants(op.conversationId));
          // Otherwise only as the app lets that member ask: with its leave to
          // ask other members, or with the User's approval of this request.
          const needs = !launched && askNeedsApproval(conversation, message!);
          const asked = launched ?? machineMayAsk(conversation, device.machineId, message!, op.participantId,
            needs ? await store.userApprovals(op.conversationId, device.deviceId) : [], contentHash(message!.content),
            needs ? await store.usedGrants(op.conversationId) : new Set());
          if (!asked) return reject(opId, "This member may ask a member that runs elsewhere only with leave to ask other members or with your approval.");
          // A launch runs its facilitator once, her approval the member once:
          // noted with the turn.
          if (typeof asked === "object") askGrant = store.useGrantsSql(op.conversationId, [asked.grant], acceptedAt);
        }
      }
      return place_({ runId: op.runId, conversationId: op.conversationId, messageId: op.messageId, participantId: op.participantId,
        state: "requested", requestedAt: acceptedAt, requestedBy: device.deviceId,
        ...(op.pendingMessageId ? { pendingMessageId: op.pendingMessageId } : {}),
        ...(op.request ? { request: op.request } : {}) }, undefined, askGrant);
    }

    // turn.claim: only where the member runs (Д4), once (Д5).
    if (home !== device.deviceId) return reject(opId, "Only the device this member runs on may take its turn.");
    const settled = claimOutcomeFor(current, device.deviceId);
    if (settled) return unchanged(settled);
    return place_({ ...(current ?? { runId: op.runId, conversationId: op.conversationId, messageId: op.messageId, participantId: op.participantId }),
      state: "claimed", executorDeviceId: device.deviceId, claimedAt: acceptedAt }, "claimed");
  }

  /** Turns asked of this device's members that nobody took yet: what a
   *  computer or machine runs after it was off. */
  async waitingTurns(device: HubDevice): Promise<HubTurn[]> {
    const devices = await this.deps.storage.hub().devices();
    const turns: HubTurn[] = [];
    const chats = new Map<string, Conversation | undefined>();
    for (const turn of await this.deps.storage.hubOps().requested()) {
      if (!chats.has(turn.conversationId)) chats.set(turn.conversationId, await this.ops.chatCache.load(turn.conversationId));
      const conversation = chats.get(turn.conversationId);
      if (conversation && homeDeviceId(conversation, turn.participantId, devices) === device.deviceId) turns.push(turn);
    }
    return turns;
  }

  /** Turns this device took and never finished: what it closes after it
   *  stopped or restarted in the middle of them. */
  async claimedTurns(device: HubDevice): Promise<HubTurn[]> {
    return this.deps.storage.hubOps().claimedBy(device.deviceId);
  }
}
