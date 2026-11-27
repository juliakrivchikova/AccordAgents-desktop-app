import type { MemoryNoteKind } from "../../../shared/memory";
import { noteTitle, splitFrontMatter } from "./entryText";

/**
 * How Claude Code and Codex keep what they remember on their own, read as
 * entries (one note each). Checked against Claude Code 2.1.332 and Codex
 * 0.171.0 on 2026-11-27.
 *
 * Claude Code's auto memory: `<config>/projects/<folder>/memory/`, where
 * `<config>` is CLAUDE_CONFIG_DIR (or `~/.claude`) and `<folder>` the git
 * repository's folder (worktrees share it) with every character that is not
 * a letter or a digit written as "-". One topic file per memory, with front
 * matter (`name`, `description`, `type`: user, feedback, project or
 * reference; in newer files under `metadata:`), and a `MEMORY.md` index of
 * lines `- [Title](file.md) — hook`.
 *
 * Codex's memories: `<CODEX_HOME>/memories/` (`~/.codex` by default).
 * `MEMORY.md` is its handbook of `# Task Group: …` blocks, each naming the
 * folder it applies to (`applies_to: cwd=…`); `memory_summary.md` the
 * profile and preferences it gives every session. The rest (raw memories,
 * rollout summaries, notes waiting to be merged) is what Codex itself merges
 * into those two, so it is not read again here.
 */

export interface ReadEntry {
  kind: MemoryNoteKind;
  title: string;
  /** As written (secrets are taken out after). */
  body: string;
  tags: string[];
}

/** The titles a Claude Code memory folder's `MEMORY.md` gives its files. */
export function claudeIndexTitles(index: string): Map<string, string> {
  const titles = new Map<string, string>();
  for (const line of index.split(/\r?\n/)) {
    const match = /^\s*[-*]\s*\[([^\]]+)\]\(\s*(?:\.\/)?([^)\s]+)\s*\)/.exec(line);
    if (!match) continue;
    const file = match[2];
    if (!file.includes("/") && /\.md$/i.test(file) && !titles.has(file)) titles.set(file, match[1].trim());
  }
  return titles;
}

/** One Claude Code memory file as an entry; undefined when it holds nothing. */
export function claudeMemoryEntry(fileName: string, text: string, indexTitle: string | undefined): ReadEntry | undefined {
  const { fields, content } = splitFrontMatter(text);
  const type = (fields.type ?? "").toLowerCase();
  const description = (fields.description ?? "").trim();
  const name = (fields.name ?? "").trim();
  const body = [description && !content.includes(description) ? description : "", content.trim()].filter(Boolean).join("\n\n");
  if (!body.trim()) return undefined;
  const title = indexTitle?.trim() || (looksLikeTitle(name) ? name : "") || description || name || fileName.replace(/\.md$/i, "").replace(/[-_]+/g, " ");
  // feedback / user: how the User wants members to work, and who she is.
  const preference = type === "feedback" || type === "user";
  const kind: MemoryNoteKind = type === "project" && looksLikeStatus(`${title}\n${description || content.slice(0, 400)}`) ? "status" : "article";
  return { kind, title: noteTitle(title), body, tags: preference ? ["preference"] : [] };
}

/** A name written for people ("Reply in Russian"), not a slug ("reply-in-russian"). */
function looksLikeTitle(name: string): boolean {
  return Boolean(name) && !/^[a-z0-9_.-]+$/.test(name);
}

/** A project memory about where one piece of work stands (a branch, what is
 *  merged or released), rather than a decision or a fact. */
function looksLikeStatus(text: string): boolean {
  return /\b(?:branch|released|merged|unreleased|pushed|committed|in progress|status)\b/i.test(text);
}

export interface CodexTaskGroup extends ReadEntry {
  /** `MEMORY.md#<task group>`, the same on every device. */
  name: string;
  /** The folder it applies to, when it names one. */
  cwd?: string;
}

/** Codex's handbook, one entry per `# Task Group:` block. */
export function codexTaskGroups(text: string): CodexTaskGroup[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const groups: CodexTaskGroup[] = [];
  const seen = new Map<string, number>();
  let current: { title: string; lines: string[] } | undefined;
  const close = () => {
    if (!current) return;
    const body = current.lines.join("\n").trim();
    const title = noteTitle(current.title);
    if (title && body) {
      const count = (seen.get(title) ?? 0) + 1;
      seen.set(title, count);
      const cwd = /^applies_to:\s*cwd=([^;\n]+)/m.exec(body)?.[1]?.trim();
      groups.push({ name: `MEMORY.md#${title}${count > 1 ? ` (${count})` : ""}`, kind: "runbook", title, body, tags: [], ...(cwd ? { cwd } : {}) });
    }
    current = undefined;
  };
  for (const line of lines) {
    const heading = /^#\s+Task Group:\s*(.+?)\s*$/.exec(line);
    if (heading) {
      close();
      current = { title: heading[1], lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  close();
  return groups;
}

/** Codex's summary of the User (profile, preferences, tips), without its
 *  list of what is in the handbook (the handbook's entries are their own). */
export function codexSummaryEntry(text: string): ReadEntry | undefined {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.trim() === "v1") lines.shift();
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const heading = /^(#{1,2})\s+(.+?)\s*$/.exec(line);
    if (heading) skipping = /^what'?s in memory$/i.test(heading[2]);
    if (!skipping) kept.push(line);
  }
  const body = kept.join("\n").trim();
  if (!body) return undefined;
  return { kind: "article", title: "Codex memory summary: the User's profile, preferences and tips", body, tags: ["preference"] };
}
