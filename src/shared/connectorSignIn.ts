import type { ChatConnectorSignInRequest } from "./types";

/**
 * A member asking the User to sign in to an MCP server (a claude.ai connector
 * or one of the CLI's own) when its task needs it, the way Claude's apps show
 * a Connect card the moment a connector is needed, and never before. The
 * member names the server; the sign-in address comes from its CLI
 * (`mcp_authenticate`), and once the User is done the app reconnects the
 * server in the member's live process (`mcp_reconnect`), so its tools are
 * there for the rest of the same reply.
 */

/** A server as the CLI's `mcp_status` lists it. */
export interface McpServerStatus {
  name: string;
  /** connected | failed | needs-auth | pending | disabled */
  status: string;
}

/** How long the member's call waits for the User, as a permission card does. */
export const CONNECTOR_SIGN_IN_WAIT_MS = 30 * 60_000;
/** One control request to the member's CLI. */
export const CONNECTOR_CONTROL_TIMEOUT_MS = 30_000;
/** A server the CLI is still connecting is given this long before it counts as failed. */
export const CONNECTOR_PENDING_WAIT_MS = 15_000;

const MAX_CONNECTOR_LENGTH = 200;
const MAX_REASON_LENGTH = 300;
const MAX_SUGGESTIONS = 8;

export function parseConnectorSignInInput(raw: unknown): { connector: string; reason?: string } {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const connector = typeof record.connector === "string" ? record.connector.trim() : "";
  if (!connector) throw new Error("connector is required: the MCP server's name as Claude Code lists it, e.g. \"claude.ai Sentry\".");
  if (connector.length > MAX_CONNECTOR_LENGTH) throw new Error("connector is too long.");
  const reason = typeof record.reason === "string" ? record.reason.trim().slice(0, MAX_REASON_LENGTH) : "";
  return { connector, ...(reason ? { reason } : {}) };
}

export function parseMcpServerStatuses(response: Record<string, unknown> | undefined): McpServerStatus[] {
  const servers = Array.isArray(response?.mcpServers) ? response!.mcpServers as unknown[] : [];
  return servers.flatMap((server) => {
    const record = server && typeof server === "object" ? server as Record<string, unknown> : {};
    return typeof record.name === "string" && typeof record.status === "string" ? [{ name: record.name, status: record.status }] : [];
  });
}

/** The name without the prefix the CLI gives a claude.ai connector or a
 *  plugin's server ("claude.ai Sentry", "plugin:acme:sentry" → "sentry"). */
function bareName(name: string): string {
  return name.replace(/^claude\.ai\s+/i, "").replace(/^plugin:[^:]+:/i, "").trim().toLowerCase();
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 3);
}

/** The server the member means: its exact name, or the one whose name
 *  without a connector or plugin prefix is it. Several equally good ones are
 *  ambiguous; none gives the names that look like it (never the whole list:
 *  an account can carry dozens of connectors). */
export function matchMcpServer(servers: McpServerStatus[], query: string):
  | { kind: "match"; server: McpServerStatus }
  | { kind: "ambiguous"; names: string[] }
  | { kind: "none"; suggestions: string[] } {
  const wanted = query.trim().toLowerCase();
  const exact = servers.filter((server) => server.name.toLowerCase() === wanted);
  if (exact.length === 1) return { kind: "match", server: exact[0] };
  const bare = servers.filter((server) => bareName(server.name) === bareName(wanted));
  if (bare.length === 1) return { kind: "match", server: bare[0] };
  if (bare.length > 1) return { kind: "ambiguous", names: bare.map((server) => server.name) };
  const queryWords = words(bareName(wanted));
  const suggestions = servers
    .filter((server) => {
      const name = bareName(server.name);
      return name.includes(bareName(wanted)) || queryWords.some((word) => name.includes(word));
    })
    .map((server) => server.name)
    .slice(0, MAX_SUGGESTIONS);
  return { kind: "none", suggestions };
}

/** Where a sign-in address leads, for the card to say before it is opened. */
export function connectorSignInHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.host : undefined;
  } catch {
    return undefined;
  }
}

export function connectorSignInSummary(handle: string, request: Pick<ChatConnectorSignInRequest, "connector" | "action">): string {
  return request.action === "sign-in"
    ? `@${handle} needs you to sign in to ${request.connector}`
    : `@${handle} can't reach ${request.connector}`;
}

export function isConnectorSignInRequest(value: unknown): value is ChatConnectorSignInRequest {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  return record?.kind === "connectorSignIn" && typeof record.connector === "string" &&
    (record.action === "sign-in" || record.action === "reconnect");
}
