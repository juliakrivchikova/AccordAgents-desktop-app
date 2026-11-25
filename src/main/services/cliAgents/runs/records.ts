import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export function parseJsonRecord(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function createLineHandler(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        onLine(line);
      }
      newline = buffer.indexOf("\n");
    }
  };
}

export async function findFileByName(
  directoryPath: string,
  fileName: string,
  maxDepth: number
): Promise<string | undefined> {
  return findFileByNameMatch(directoryPath, (name) => name === fileName, maxDepth);
}

export async function findFileByNameMatch(
  directoryPath: string,
  matchesFileName: (fileName: string) => boolean,
  maxDepth: number
): Promise<string | undefined> {
  let entries: Dirent[];
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isFile() && matchesFileName(entry.name)) {
      return entryPath;
    }
  }
  if (maxDepth <= 0) {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const found = await findFileByNameMatch(path.join(directoryPath, entry.name), matchesFileName, maxDepth - 1);
    if (found) {
      return found;
    }
  }
  return undefined;
}

export async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

export function findStringField(value: unknown, keys: string[]): string | undefined {
  const stack: unknown[] = [value];
  const wanted = new Set(keys);
  while (stack.length) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    const record = asRecord(current);
    if (!record) {
      continue;
    }
    for (const key of wanted) {
      const text = stringField(record, key);
      if (text?.trim()) {
        return text.trim();
      }
    }
    stack.push(...Object.values(record).filter((nested) => nested && typeof nested === "object"));
  }
  return undefined;
}

export async function readOptionalFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

export function findSessionId(value: unknown): string | undefined {
  const stack: unknown[] = [value];
  const preferredKeys = new Set(["session_id", "sessionId", "conversation_id", "conversationId", "thread_id", "threadId", "id"]);
  while (stack.length) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    const record = asRecord(current);
    if (!record) {
      continue;
    }
    for (const key of preferredKeys) {
      const sessionId = uuidText(record[key]);
      if (sessionId) {
        return sessionId;
      }
    }
    const type = stringField(record, "type") ?? "";
    if (type.toLowerCase().includes("session")) {
      const sessionId = Object.values(record).map((nested) => uuidText(nested)).find(Boolean);
      if (sessionId) {
        return sessionId;
      }
    }
    stack.push(...Object.values(record).filter((nested) => nested && typeof nested === "object"));
  }
  return undefined;
}

export function uuidText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  return match?.[0];
}
