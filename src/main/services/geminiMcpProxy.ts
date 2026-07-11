// Standalone stdio<->HTTP bridge for the Antigravity CLI (`agy`) App-MCP
// integration. agy can only launch MCP servers from the global
// `~/.gemini/config/mcp_config.json` (stdio command or SSE url, no auth
// headers), so the app registers this script as the `accord_agents` stdio
// server and passes the per-run bridge endpoint through the environment agy
// inherits from the app:
//
//   ACCORD_AGENTS_MCP_URL   e.g. http://127.0.0.1:<port>/mcp
//   ACCORD_AGENTS_MCP_TOKEN per-run bearer token
//
// In packaged builds the Electron binary starts the app with the dedicated
// proxy argv flag. The main entrypoint dispatches here before initializing the
// desktop app. The module can also be executed directly by plain Node in tests.
// Keep it dependency-free: node builtins only, no imports from app modules.

import http from "node:http";

const REQUEST_TIMEOUT_MS = 10 * 60_000;

export function runGeminiMcpProxy(): void {
  const url = process.env.ACCORD_AGENTS_MCP_URL;
  const token = process.env.ACCORD_AGENTS_MCP_TOKEN;
  if (!url || !token) {
    // No app tools were granted for this run; exit quietly so agy reports the
    // server as unavailable instead of hanging.
    process.stderr.write("accord_agents MCP bridge: missing ACCORD_AGENTS_MCP_URL/ACCORD_AGENTS_MCP_TOKEN.\n");
    process.exit(1);
  }

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        void forward(url, token, line);
      }
      newline = buffer.indexOf("\n");
    }
  });
  process.stdin.on("end", () => {
    process.exit(0);
  });
}

async function forward(url: string, token: string, line: string): Promise<void> {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    writeMessage({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  try {
    const responseText = await postJson(url, token, line);
    if (!responseText.trim()) {
      return;
    }
    const response = JSON.parse(responseText) as unknown;
    if (Array.isArray(response)) {
      for (const item of response) {
        writeMessage(item);
      }
      return;
    }
    writeMessage(response);
  } catch (error) {
    const id = messageId(message);
    if (id === undefined) {
      return;
    }
    const text = error instanceof Error ? error.message : String(error);
    writeMessage({ jsonrpc: "2.0", id, error: { code: -32603, message: `AccordAgents MCP bridge request failed: ${text}` } });
  }
}

function postJson(url: string, token: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${token}`
        },
        timeout: REQUEST_TIMEOUT_MS
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = response.statusCode ?? 0;
          if (status === 202 || status === 204) {
            resolve("");
            return;
          }
          if (status >= 200 && status < 300) {
            resolve(text);
            return;
          }
          reject(new Error(`HTTP ${status}${text ? `: ${text.slice(0, 200)}` : ""}`));
        });
      }
    );
    request.on("timeout", () => {
      request.destroy(new Error("request timed out"));
    });
    request.on("error", reject);
    request.end(body);
  });
}

function writeMessage(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function messageId(message: unknown): unknown {
  if (message && typeof message === "object" && !Array.isArray(message) && "id" in message) {
    return (message as { id?: unknown }).id;
  }
  return undefined;
}

if (require.main === module) {
  runGeminiMcpProxy();
}
