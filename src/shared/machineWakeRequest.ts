/**
 * Waking a stopped machine from a device, without a relay and without a server.
 *
 * Rule 3 of the signed resolution: the phone wakes an AWS-managed machine
 * itself, with a narrowly scoped key handed to it sealed at pairing. The relay
 * never sees or stores that key, and there is no wake broker to ask.
 *
 * The desktop can use the AWS SDK; the installed PWA cannot. So the request is
 * built here as data — method, url, headers, body — signed with SigV4 through
 * an injected HMAC/SHA-256 pair. In the browser those come from WebCrypto; in
 * Node from `node:crypto`. `machineWakeRequest.test.ts` checks the result byte
 * for byte against `@aws-sdk/signature-v4`, so this is the same signature the
 * desktop would produce, not a lookalike.
 *
 * Only two actions exist here, both bounded to the one instance the handoff
 * names: read its state, and start it. Stopping stays with the machine itself,
 * which is the only party that can prove its own work has drained.
 */

import type { MachinePowerCredentials } from "./machinePower";

export interface MachineWakeCrypto {
  sha256Hex(data: string): Promise<string>;
  hmacSha256(key: Uint8Array, data: string): Promise<Uint8Array>;
}

export interface MachineWakeHttpRequest {
  method: "POST";
  url: string;
  headers: Record<string, string>;
  body: string;
}

export type MachineWakeAction = "start" | "describe";

const SERVICE = "ec2";
const API_VERSION = "2016-11-15";

/**
 * Builds the signed EC2 call for one instance. The instance id is taken from
 * the handoff, never from the caller, so a device cannot aim this at another
 * machine even if its own UI is wrong.
 */
export async function machineWakeRequest(options: {
  action: MachineWakeAction;
  instanceId: string;
  credentials: MachinePowerCredentials;
  crypto: MachineWakeCrypto;
  now?: Date;
}): Promise<MachineWakeHttpRequest> {
  if (!/^i-[a-f0-9]{8,17}$/.test(options.instanceId)) {
    throw new Error("A machine wake needs the instance id from its pairing.");
  }
  const region = options.credentials.region;
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region)) {
    throw new Error("Invalid AWS region.");
  }
  const host = `${SERVICE}.${region}.amazonaws.com`;
  const body = new URLSearchParams({
    Action: options.action === "start" ? "StartInstances" : "DescribeInstances",
    Version: API_VERSION,
    "InstanceId.1": options.instanceId
  }).toString();
  const now = options.now ?? new Date();
  const amzDate = `${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await options.crypto.sha256Hex(body);

  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded; charset=utf-8",
    host,
    // Signed as well, so the header set matches what the AWS SDK signs and the
    // test can compare the two signatures byte for byte.
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate
  };
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = `${signedHeaderNames.map((name) => `${name}:${headers[name].trim()}`).join("\n")}\n`;
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = ["POST", "/", "", canonicalHeaders, signedHeaders, payloadHash].join("\n");

  const scope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await options.crypto.sha256Hex(canonicalRequest)
  ].join("\n");

  const encoder = new TextEncoder();
  let key = await options.crypto.hmacSha256(encoder.encode(`AWS4${options.credentials.secretAccessKey}`), dateStamp);
  key = await options.crypto.hmacSha256(key, region);
  key = await options.crypto.hmacSha256(key, SERVICE);
  key = await options.crypto.hmacSha256(key, "aws4_request");
  const signature = toHex(await options.crypto.hmacSha256(key, stringToSign));

  return {
    method: "POST",
    url: `https://${host}/`,
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${options.credentials.accessKeyId}/${scope}, `
        + `SignedHeaders=${signedHeaders}, Signature=${signature}`
    },
    body
  };
}

/** The slice of WebCrypto this needs, described structurally so this module
 *  compiles for the Node main process and the browser alike. */
export interface MachineWakeSubtleCrypto {
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
  importKey(
    format: "raw", keyData: Uint8Array, algorithm: { name: string; hash: string },
    extractable: boolean, usages: string[]
  ): Promise<unknown>;
  sign(algorithm: string, key: never, data: Uint8Array): Promise<ArrayBuffer>;
}

/** WebCrypto in the installed PWA; Node's `crypto.subtle` satisfies it too. */
export function webCryptoMachineWake(subtle: MachineWakeSubtleCrypto): MachineWakeCrypto {
  const encoder = new TextEncoder();
  return {
    async sha256Hex(data) {
      return toHex(new Uint8Array(await subtle.digest("SHA-256", encoder.encode(data))));
    },
    async hmacSha256(key, data) {
      const imported = await subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      return new Uint8Array(await subtle.sign("HMAC", imported as never, encoder.encode(data)));
    }
  };
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
