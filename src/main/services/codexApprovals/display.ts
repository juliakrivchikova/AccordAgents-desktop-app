import type { ChatCodexCommandActionSummary, ChatCodexFileChangeSummary, ChatCodexPermissionSummary } from "../../../shared/types";
import { MAX_DISPLAY_ITEMS, MAX_DISPLAY_PATH, MAX_DISPLAY_TEXT } from "./constants";
import { record } from "./fields";

export function permissionSummary(value: unknown, networkContext?: unknown): ChatCodexPermissionSummary | undefined {
  const permissions = record(value);
  const network = record(permissions?.network);
  const fileSystem = record(permissions?.fileSystem);
  const summary: ChatCodexPermissionSummary = {};
  if (network?.enabled === true || record(networkContext)) summary.network = true;
  const readPaths = displayStringArray(fileSystem?.read);
  const writePaths = displayStringArray(fileSystem?.write);
  for (const entry of Array.isArray(fileSystem?.entries) ? fileSystem.entries.slice(0, MAX_DISPLAY_ITEMS) : []) {
    const entryRecord = record(entry);
    const entryPath = fileSystemEntryPath(entryRecord?.path);
    if (!entryPath) continue;
    if (entryRecord?.access === "read") readPaths.push(entryPath);
    if (entryRecord?.access === "write") writePaths.push(entryPath);
  }
  if (readPaths.length > 0) summary.readPaths = unique(readPaths);
  if (writePaths.length > 0) summary.writePaths = unique(writePaths);
  return Object.keys(summary).length > 0 ? summary : undefined;
}

function fileSystemEntryPath(value: unknown): string | undefined {
  const candidate = record(value);
  if (!candidate) return undefined;
  if (candidate.type === "path") return displayString(candidate.path, MAX_DISPLAY_PATH);
  if (candidate.type === "glob_pattern") return displayString(candidate.pattern, MAX_DISPLAY_PATH);
  if (candidate.type === "special") return displayString(candidate.value, MAX_DISPLAY_PATH);
  return undefined;
}

export function fileChangeSummary(value: unknown): ChatCodexFileChangeSummary[] | undefined {
  if (Array.isArray(value)) {
    const summary = value.slice(0, MAX_DISPLAY_ITEMS).flatMap((item): ChatCodexFileChangeSummary[] => {
      const change = record(item);
      const path = displayString(change?.path, MAX_DISPLAY_PATH);
      const kind = record(change?.kind)?.type ?? change?.change ?? change?.type;
      if (!path) return [];
      return [{
        path,
        change: kind === "add" || kind === "delete" || kind === "update" ? kind : "unknown"
      }];
    });
    return summary.length > 0 ? summary : undefined;
  }
  const changes = record(value);
  if (!changes) return undefined;
  const summary = Object.entries(changes).slice(0, MAX_DISPLAY_ITEMS).map(([path, change]) => {
    const changeType = record(change)?.type;
    return {
      path: displayString(path, MAX_DISPLAY_PATH) ?? "<redacted>",
      change: changeType === "add" || changeType === "delete" || changeType === "update" ? changeType : "unknown"
    } satisfies ChatCodexFileChangeSummary;
  });
  return summary.length > 0 ? summary : undefined;
}

export function displayStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const text = displayString(item, MAX_DISPLAY_PATH);
        return text ? [text] : [];
      }).slice(0, MAX_DISPLAY_ITEMS)
    : [];
}

export function displayArgv(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const argv = value.flatMap((item) => typeof item === "string" ? [redactApprovalText(item)] : []);
  return boundedString(argv.map((item) => JSON.stringify(item)).join(" "), MAX_DISPLAY_TEXT);
}

export function commandActionSummary(value: unknown): ChatCodexCommandActionSummary[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const actions = value.slice(0, MAX_DISPLAY_ITEMS).flatMap((item): ChatCodexCommandActionSummary[] => {
    const action = record(item);
    if (!action) return [];
    const rawType = action.type;
    const type = rawType === "list_files" ? "listFiles" : rawType;
    if (type !== "read" && type !== "listFiles" && type !== "search" && type !== "unknown") return [];
    const command = displayString(action.command ?? action.cmd, MAX_DISPLAY_TEXT);
    if (!command) return [];
    return [{
      type,
      command,
      name: displayString(action.name, MAX_DISPLAY_TEXT),
      path: displayString(action.path, MAX_DISPLAY_PATH),
      query: displayString(action.query, MAX_DISPLAY_TEXT)
    }];
  });
  return actions.length > 0 ? actions : undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].slice(0, MAX_DISPLAY_ITEMS);
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

export function displayString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" ? boundedString(redactApprovalText(value), maxLength) : undefined;
}

export function redactCodexApprovalText(value: string): string {
  return redactApprovalText(value);
}

export function redactApprovalText(value: string): string {
  return value
    .replace(/\b(Authorization\s*:\s*Bearer\s+)([^\s"',;]+)/gi, "$1••••")
    .replace(/((?:^|[\s,{?&])(?:["']?)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret)(?:["']?)\s*(?:=|:)\s*["']?)([^\s"',;}&#]+)/gim, "$1••••")
    .replace(/(--(?:api-key|access-token|refresh-token|token|password|secret)\s+)([^\s]+)/gi, "$1••••")
    .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{12,})\b/g, "••••");
}
