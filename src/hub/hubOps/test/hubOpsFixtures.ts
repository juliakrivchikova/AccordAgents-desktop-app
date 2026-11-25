// What the operations' tests set up.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ChatSearchService } from "../../../main/services/chatSearch";
import { createDeviceIdentity } from "../../../main/services/deviceIdentity";
import { signHubRequest, type HubSigningIdentity } from "../../../main/services/hubAuth";
import { StorageService } from "../../../main/services/storage";
import type { HubOp, HubOpsResponse } from "../../../shared/hubOps";
import type { ChatMessage } from "../../../shared/types";
import { HubOps } from "../../hubOps";
import { HubServer } from "../../hubServer";

export type Identity = ReturnType<typeof createDeviceIdentity>;

export async function hub(t: test.TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-hub-ops-"));
  const storage = new StorageService({ dbPath: path.join(dir, "hub.sqlite3"), sqliteExecutable: "sqlite3" });
  await storage.init();
  const now = () => new Date().toISOString();
  const owner = createDeviceIdentity(now());
  const phone = createDeviceIdentity(now());
  const machine = createDeviceIdentity(now());
  await storage.hub().setOwner({ deviceId: owner.originId, publicKeyDerBase64: owner.publicKeyDerBase64, name: "Desktop", addedAt: now() });
  const logged: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const log = (event: string, payload: Record<string, unknown>) => { logged.push({ event, payload }); };
  const ops = new HubOps(storage, log);
  const server = new HubServer({
    hubId: "hub-test", version: "test", storage, search: new ChatSearchService(storage), vapidPublicKey: "BPUB",
    ops, debugLog: log
  });
  const http = await server.listenHttp(0, "127.0.0.1");
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  t.after(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  const call = async <T = Record<string, unknown>>(identity: HubSigningIdentity, method: string, pathWithQuery: string, body?: unknown) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    const response = await fetch(`${base}${pathWithQuery}`, {
      method,
      headers: { authorization: signHubRequest(identity, { method, pathWithQuery, body: text }), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: text })
    });
    return { status: response.status, body: await response.json() as T };
  };
  const roster = await call(owner, "PUT", "/v1/roster", { devices: [
    { deviceId: phone.originId, publicKeyDerBase64: phone.publicKeyDerBase64, role: "phone", name: "Phone", scope: { scope: "device" } },
    { deviceId: machine.originId, publicKeyDerBase64: machine.publicKeyDerBase64, role: "machine", name: "Box", machineId: "machine-1" }
  ] });
  assert.equal(roster.status, 200);
  const write = (identity: Identity, ...list: HubOp[]) => call<HubOpsResponse>(identity, "POST", "/v3/ops", { ops: list });
  return { storage, ops, owner, phone, machine, call, write, logged };
}

let counter = 0;

export const id = (prefix: string) => `${prefix}-${++counter}`;

export const members = [
  { id: "p-desk", handle: "desk", label: "Desk" },
  { id: "p-box", handle: "box", label: "Box", homeMachineId: "machine-1" }
];

export function createChat(conversationId: string, title = "Plans"): HubOp {
  return { opId: id("op"), kind: "conversation.create", conversationId,
    conversation: { title, kind: "chat", createdAt: new Date().toISOString(), metadata: { participants: members, warnings: ["local"] } } };
}

export function userMessage(messageId: string, content: string, targets: string[] = []): ChatMessage {
  return { id: messageId, role: "user", content, createdAt: new Date().toISOString(), ...(targets.length ? { metadata: { deliveryTargets: targets } } : {}) } as ChatMessage;
}

export function reply(messageId: string, participantId: string, status: ChatMessage["status"], content = ""): ChatMessage {
  return { id: messageId, role: "participant", participantId, content, status, createdAt: new Date().toISOString() } as ChatMessage;
}

// --- documents (artifacts) on the server (Д9) --------------------------------

type ArtifactAnswer = { ok: boolean; value?: Record<string, unknown> & { summary?: { id: string; headVersion: number; approval: { state: string; signedCurrent: string[] } }; version?: { version: number; versionEventId: string; contentHash: string; content: string; signatures: Array<{ signer: string }> }; id?: string; editRevision?: number }; error?: { code: string; message: string; current?: { version: number; content: string }; currentVersion?: number } };

export function artifactOp(kind: string, chat: string, actor: string, request: Record<string, unknown>): HubOp {
  return { opId: id("op"), kind, conversationId: chat, actor, request: { conversationId: chat, ...request } } as unknown as HubOp;
}

export function answerOf(response: { body: HubOpsResponse }): ArtifactAnswer {
  return (response.body.results[0] as { artifact?: { result?: ArtifactAnswer } }).artifact?.result as ArtifactAnswer;
}
