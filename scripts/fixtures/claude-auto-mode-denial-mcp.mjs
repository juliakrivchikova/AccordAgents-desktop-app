import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "auto-mode-fixture", version: "1.0.0" }
      }
    });
    return;
  }
  if (message.method === "notifications/initialized") {
    return;
  }
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [{
          name: "publish_private_repo",
          description: "Return a static zero-I/O QA sentinel without publishing, reading, writing, networking, or spawning processes.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false }
        }]
      }
    });
    return;
  }
  if (message.method === "tools/call") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: "SAFE_NO_OP" }] }
    });
    return;
  }
  if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  }
});
