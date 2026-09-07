/**
 * Waking a stopped AWS machine from the phone.
 *
 * Rule 3 of the signed resolution: the device does it itself with the narrowly
 * scoped key handed over sealed at pairing. The relay never sees that key and
 * there is no broker to ask, so the request is signed here and sent straight to
 * the EC2 API.
 *
 * This mirrors src/shared/machineWakeRequest.ts exactly - the PWA cannot load
 * the AWS SDK, and scripts/mobile-machine-wake.test.mjs asserts the two produce
 * byte-identical requests, so they cannot drift apart. The TypeScript one is in
 * turn checked against @smithy/signature-v4.
 *
 * Only two actions exist, and both are bound to the instance the handoff names:
 * read its state, and start it. Stopping stays with the machine itself, the
 * only party that can prove its own work has drained.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AccordMobileMachineWake = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  const SERVICE = "ec2";
  const API_VERSION = "2016-11-15";
  const INSTANCE_PATTERN = /^i-[a-f0-9]{8,17}$/;
  const REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d$/;

  function toHex(bytes) {
    return Array.from(bytes).map(function (byte) { return byte.toString(16).padStart(2, "0"); }).join("");
  }

  function webCrypto(subtle) {
    const encoder = new TextEncoder();
    return {
      async sha256Hex(data) {
        return toHex(new Uint8Array(await subtle.digest("SHA-256", encoder.encode(data))));
      },
      async hmacSha256(key, data) {
        const imported = await subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        return new Uint8Array(await subtle.sign("HMAC", imported, encoder.encode(data)));
      }
    };
  }

  async function machineWakeRequest(options) {
    const instanceId = options.instanceId;
    if (!INSTANCE_PATTERN.test(String(instanceId || ""))) {
      throw new Error("A machine wake needs the instance id from its pairing.");
    }
    const credentials = options.credentials;
    const region = credentials.region;
    if (!REGION_PATTERN.test(String(region || ""))) {
      throw new Error("Invalid AWS region.");
    }
    const crypto = options.crypto;
    const host = SERVICE + "." + region + ".amazonaws.com";
    const body = new URLSearchParams({
      Action: options.action === "start" ? "StartInstances" : "DescribeInstances",
      Version: API_VERSION,
      "InstanceId.1": instanceId
    }).toString();
    const now = options.now || new Date();
    const amzDate = now.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = await crypto.sha256Hex(body);

    const headers = {
      "content-type": "application/x-www-form-urlencoded; charset=utf-8",
      host: host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate
    };
    const signedHeaderNames = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaderNames.map(function (name) {
      return name + ":" + String(headers[name]).trim();
    }).join("\n") + "\n";
    const signedHeaders = signedHeaderNames.join(";");
    const canonicalRequest = ["POST", "/", "", canonicalHeaders, signedHeaders, payloadHash].join("\n");

    const scope = dateStamp + "/" + region + "/" + SERVICE + "/aws4_request";
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      await crypto.sha256Hex(canonicalRequest)
    ].join("\n");

    const encoder = new TextEncoder();
    let key = await crypto.hmacSha256(encoder.encode("AWS4" + credentials.secretAccessKey), dateStamp);
    key = await crypto.hmacSha256(key, region);
    key = await crypto.hmacSha256(key, SERVICE);
    key = await crypto.hmacSha256(key, "aws4_request");
    const signature = toHex(await crypto.hmacSha256(key, stringToSign));

    const authorization = "AWS4-HMAC-SHA256 Credential=" + credentials.accessKeyId + "/" + scope + ", " +
      "SignedHeaders=" + signedHeaders + ", Signature=" + signature;
    return {
      method: "POST",
      url: "https://" + host + "/",
      headers: Object.assign({}, headers, { authorization: authorization }),
      body: body
    };
  }

  return { machineWakeRequest: machineWakeRequest, webCrypto: webCrypto };
});
