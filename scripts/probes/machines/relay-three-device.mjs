import WebSocket from "ws";
import assert from "node:assert/strict";
const base = process.argv[2] ?? "ws://127.0.0.1:18099/v1/relay";
function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url); const inbox = []; const waiters = []; const closeWaiters = [];
    socket.on("message", (d) => { const parsed = JSON.parse(String(d)); const w = waiters.shift(); if (w) w(parsed); else inbox.push(parsed); });
    socket.on("close", (code, reason) => { for (const w of closeWaiters.splice(0)) w({ code, reason: reason.toString() }); });
    socket.once("open", () => resolve({ socket, nextJson: () => inbox.length ? Promise.resolve(inbox.shift()) : new Promise((r) => waiters.push(r)), pending: () => inbox.length, closedWith: () => new Promise((r) => closeWaiters.push(r)) }));
    socket.once("error", reject);
  });
}
const frame = (id, chunk, extra = {}) => ({ protocol: "accord-relay-v1", streamId: "s", logicalMessageId: id, frameId: `${id}:0:1`, frameIndex: 0, frameCount: 1, ciphertextChunk: chunk, ...extra });
const rid = "rv-machines-" + Date.now();
const desktop = await connect(`${base}?rid=${rid}&role=desktop&cap=CAP`);
const dReady = await desktop.nextJson(); assert.equal(dReady.type, "relay.ready"); assert.equal(dReady.deviceId, "desktop"); assert.deepEqual(dReady.peers, []);
const phone = await connect(`${base}?rid=${rid}&role=phone&cap=CAP`);
const pReady = await phone.nextJson(); assert.equal(pReady.peerConnected, true);
assert.deepEqual(await desktop.nextJson(), { type: "relay.peer-connected", role: "phone", rendezvousId: rid, deviceId: "phone" });
const machine = await connect(`${base}?rid=${rid}&role=machine&cap=CAP&did=device-m1`);
const mReady = await machine.nextJson(); assert.equal(mReady.deviceId, "device-m1"); assert.equal(mReady.peerConnected, true); assert.deepEqual(mReady.peers.map((p) => p.deviceId).sort(), ["desktop", "phone"]);
assert.deepEqual(await desktop.nextJson(), { type: "relay.peer-connected", role: "machine", rendezvousId: rid, deviceId: "device-m1" });
let p = desktop.nextJson(); machine.socket.send(JSON.stringify(frame("m-1", "from-machine", { to: "desktop" }))); assert.deepEqual(await p, frame("m-1", "from-machine", { to: "desktop" }));
p = machine.nextJson(); desktop.socket.send(JSON.stringify(frame("d-1", "to-machine", { to: "device-m1" }))); assert.deepEqual(await p, frame("d-1", "to-machine", { to: "device-m1" }));
p = phone.nextJson(); desktop.socket.send(JSON.stringify(frame("d-2", "legacy"))); assert.deepEqual(await p, frame("d-2", "legacy"));
p = desktop.nextJson(); desktop.socket.send(JSON.stringify(frame("d-3", "nowhere", { to: "device-absent" }))); assert.deepEqual(await p, { type: "relay.error", code: "peer-not-connected", to: "device-absent" });
p = desktop.nextJson(); machine.socket.close(); assert.deepEqual(await p, { type: "relay.peer-disconnected", role: "machine", rendezvousId: rid, deviceId: "device-m1" });
assert.equal(phone.pending(), 0);
const rejected = await connect(`${base}?rid=${rid}&role=machine&cap=CAP`); assert.deepEqual(await rejected.closedWith(), { code: 1008, reason: "invalid relay pairing request" });
const first = await connect(`${base}?rid=${rid}&role=machine&cap=CAP&did=device-m2`); await first.nextJson(); const fc = first.closedWith();
const second = await connect(`${base}?rid=${rid}&role=machine&cap=CAP&did=device-m2`); const seated = await second.nextJson(); assert.deepEqual(await fc, { code: 4001, reason: "replaced by newer connection" }); assert.equal(seated.deviceId, "device-m2");
desktop.socket.close(); phone.socket.close(); second.socket.close();
console.log("THREE-DEVICE ROOM: PASS on", base);
