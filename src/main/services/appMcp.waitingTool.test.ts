import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { APP_CONNECTOR_SIGN_IN_TOOL, AppMcpService } from "./appMcp";

const GRANT = {
  conversationId: "c1", participantId: "p1", roleConfigId: "r1", roleConfigVersion: 1, capabilities: ["permissions.request" as const]
};

function post(url: string, token: string, body: unknown, accept: string): Promise<{ response: http.IncomingMessage; request: http.ClientRequest }> {
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept, authorization: `Bearer ${token}` }
    }, (response) => resolve({ response, request }));
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}

function call(id: number, progressToken?: number) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name: APP_CONNECTOR_SIGN_IN_TOOL, arguments: { connector: "claude.ai Sentry" }, ...(progressToken !== undefined ? { _meta: { progressToken } } : {}) } };
}

test("a call that waits for the User answers as a stream: progress while it waits, then its result", async () => {
  const service = new AppMcpService();
  service.waitingProgressMs = 20;
  let release!: () => void;
  service.setConnectorSignInHandler(() => new Promise((resolve) => { release = () => resolve({ status: "connected" }); }));
  await service.start();
  try {
    const connection = service.issueToken(GRANT)!;
    const { response } = await post(connection.url, connection.token, call(7, 3), "application/json, text/event-stream");
    assert.equal(response.headers["content-type"], "text/event-stream", "headers go out at once, so the CLI's 60 s wait for an answer never runs out");
    let text = "";
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => { text += chunk; });
    while (!text.includes("notifications/progress")) await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await new Promise((resolve) => response.on("end", resolve));
    const events = text.split("\n\n").filter((block) => block.startsWith("event: message")).map((block) => JSON.parse(block.slice(block.indexOf("data: ") + 6)));
    assert.ok(events.some((event) => event.method === "notifications/progress" && event.params.progressToken === 3));
    const answer = events.at(-1);
    assert.equal(answer.id, 7);
    assert.match(answer.result.content[0].text, /"status": ?"connected"/);
  } finally {
    await service.stop();
  }
});

test("the CLI giving up on a waiting call aborts the wait", async () => {
  const service = new AppMcpService();
  service.waitingProgressMs = 20;
  let aborted!: () => void;
  const abortedSeen = new Promise<void>((resolve) => { aborted = resolve; });
  service.setConnectorSignInHandler((_actor, _request, signal) => new Promise((resolve) => {
    signal?.addEventListener("abort", () => { aborted(); resolve({ status: "expired" }); });
  }));
  await service.start();
  try {
    const connection = service.issueToken(GRANT)!;
    const { request, response } = await post(connection.url, connection.token, call(8), "application/json, text/event-stream");
    response.resume();
    request.destroy();
    await abortedSeen;
  } finally {
    await service.stop();
  }
});

test("a client that takes only JSON gets a plain JSON answer", async () => {
  const service = new AppMcpService();
  service.setConnectorSignInHandler(async () => ({ status: "connected" }));
  await service.start();
  try {
    const connection = service.issueToken(GRANT)!;
    const { response } = await post(connection.url, connection.token, call(9), "application/json");
    assert.match(String(response.headers["content-type"]), /application\/json/);
    let text = "";
    response.setEncoding("utf8");
    for await (const chunk of response) text += chunk;
    assert.equal(JSON.parse(text).id, 9);
  } finally {
    await service.stop();
  }
});
