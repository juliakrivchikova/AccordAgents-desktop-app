import assert from "node:assert/strict";
import { createHash, createHmac, webcrypto } from "node:crypto";
import test from "node:test";
import { SignatureV4 } from "@smithy/signature-v4";
import { machineWakeRequest, webCryptoMachineWake, type MachineWakeCrypto } from "./machineWakeRequest";

const credentials = {
  accessKeyId: "AKIAEXAMPLEWAKEKEY001",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  region: "us-east-1"
};
const nodeCrypto: MachineWakeCrypto = {
  async sha256Hex(data) { return createHash("sha256").update(data).digest("hex"); },
  async hmacSha256(key, data) { return new Uint8Array(createHmac("sha256", key).update(data).digest()); }
};
const now = new Date("2026-09-07T06:30:00.000Z");

/** The hash object @smithy/signature-v4 expects, backed by node:crypto. */
class NodeSha256 {
  private readonly secret?: Uint8Array | string;
  private hash: { update(data: never): void; digest(): Buffer };
  constructor(secret?: Uint8Array | string) {
    this.secret = secret;
    this.hash = this.fresh();
  }
  private fresh(): { update(data: never): void; digest(): Buffer } {
    return this.secret === undefined
      ? createHash("sha256")
      : createHmac("sha256", this.secret as never);
  }
  update(data: Uint8Array | string): void { this.hash.update(data as never); }
  async digest(): Promise<Uint8Array> { return new Uint8Array(this.hash.digest()); }
  reset(): void { this.hash = this.fresh(); }
}

test("the signature is byte for byte the one the AWS SDK produces", async () => {
  // The phone cannot load the AWS SDK, so this builds the request itself. It
  // must be the SAME signature the desktop would send, not a lookalike.
  const request = await machineWakeRequest({
    action: "start", instanceId: "i-0943b28f7231ab93c", credentials, crypto: nodeCrypto, now
  });
  const signer = new SignatureV4({
    service: "ec2", region: credentials.region, sha256: NodeSha256 as never,
    credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey }
  });
  const signed = await signer.sign({
    method: "POST", protocol: "https:", hostname: `ec2.${credentials.region}.amazonaws.com`, path: "/",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=utf-8",
      host: `ec2.${credentials.region}.amazonaws.com`
    },
    body: request.body, query: {}
  } as never, { signingDate: now });
  assert.equal(request.headers.authorization, (signed as unknown as { headers: Record<string, string> }).headers.authorization);
  assert.equal(request.headers["x-amz-date"], (signed as unknown as { headers: Record<string, string> }).headers["x-amz-date"]);
});

test("only the paired instance can be started, and only start or read", async () => {
  const start = await machineWakeRequest({ action: "start", instanceId: "i-0943b28f7231ab93c", credentials, crypto: nodeCrypto, now });
  assert.match(start.body, /Action=StartInstances/);
  assert.match(start.body, /InstanceId\.1=i-0943b28f7231ab93c/);
  assert.equal(start.url, "https://ec2.us-east-1.amazonaws.com/");

  const describe = await machineWakeRequest({ action: "describe", instanceId: "i-0943b28f7231ab93c", credentials, crypto: nodeCrypto, now });
  assert.match(describe.body, /Action=DescribeInstances/);
  // Nothing here can stop or terminate: the machine stops itself, because it
  // is the only party that can prove its own work has drained.
  assert.ok(!/StopInstances|TerminateInstances/.test(start.body + describe.body));
});

test("a malformed instance id or region is refused before anything is signed", async () => {
  await assert.rejects(
    machineWakeRequest({ action: "start", instanceId: "not-an-instance", credentials, crypto: nodeCrypto, now }),
    /instance id from its pairing/
  );
  await assert.rejects(
    machineWakeRequest({ action: "start", instanceId: "i-0943b28f7231ab93c", credentials: { ...credentials, region: "moon-1" }, crypto: nodeCrypto, now }),
    /Invalid AWS region/
  );
});

test("the WebCrypto path the PWA uses produces the same request as Node's", async () => {
  const viaNode = await machineWakeRequest({ action: "start", instanceId: "i-0943b28f7231ab93c", credentials, crypto: nodeCrypto, now });
  const viaWebCrypto = await machineWakeRequest({
    action: "start", instanceId: "i-0943b28f7231ab93c", credentials,
    crypto: webCryptoMachineWake(webcrypto.subtle as never), now
  });
  assert.deepEqual(viaWebCrypto, viaNode);
});
