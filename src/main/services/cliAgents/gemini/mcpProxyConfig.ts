import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { GEMINI_APP_MCP_SERVER } from "../../geminiExec";

const GEMINI_MCP_PROXY_ARG = "--accordagents-gemini-mcp-proxy";

export class CliGeminiResumeMissError extends Error {
  constructor(status: string, response: string | undefined) {
    super(`Antigravity CLI could not resume the conversation (status ${status})${response ? `: ${response.slice(0, 200)}` : "."}`);
    this.name = "CliGeminiResumeMissError";
  }
}

export interface GeminiMcpConfigEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export async function syncGeminiMcpConfig(
  configPath: string,
  desiredEntry: GeminiMcpConfigEntry
): Promise<void> {
  let config: Record<string, unknown>;
  try {
    const contents = await readFile(configPath, "utf8");
    if (!contents.trim()) {
      config = {};
    } else {
      const parsed = JSON.parse(contents) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Antigravity MCP config must contain a JSON object.");
      }
      config = parsed as Record<string, unknown>;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
    config = {};
  }
  if (
    config.mcpServers !== undefined &&
    (!config.mcpServers || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers))
  ) {
    throw new Error("Antigravity MCP config field mcpServers must contain a JSON object.");
  }
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  if (JSON.stringify(servers[GEMINI_APP_MCP_SERVER]) === JSON.stringify(desiredEntry)) {
    return;
  }
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify({
    ...config,
    mcpServers: { ...servers, [GEMINI_APP_MCP_SERVER]: desiredEntry }
  }, null, 2)}\n`, "utf8");
}

export function geminiMcpProxyLaunchArgs(
  defaultApp = Boolean(process.defaultApp),
  defaultAppPath = process.argv[1]
): string[] {
  const appPath = defaultApp && defaultAppPath?.trim()
    ? path.resolve(defaultAppPath.trim())
    : undefined;
  return [...(appPath ? [appPath] : []), GEMINI_MCP_PROXY_ARG];
}
