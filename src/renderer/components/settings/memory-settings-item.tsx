import { UserRound } from "lucide-react";

import type { MemoryNoteSummary } from "../../../shared/memory";

export const MEMORY_KIND_LABELS: Record<MemoryNoteSummary["kind"], string> = {
  runbook: "Runbook",
  article: "Article",
  status: "Status"
};

export function memoryDate(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

function folderName(projectPath: string | undefined): string {
  if (!projectPath) return "a project";
  const parts = projectPath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? projectPath;
}

/** Who sees the note, in the User's words. */
export function memoryScopeLabel(note: MemoryNoteSummary, roleLabels: Record<string, string>, chatTitles: Record<string, string>): string {
  if (note.scope === "global") return "Every member";
  if (note.scope === "project") return `Project ${folderName(note.projectPath)}`;
  if (note.scope === "role") return `Role ${note.roleId ? roleLabels[note.roleId] ?? note.roleId : ""}`.trim();
  return `Chat “${note.conversationId ? chatTitles[note.conversationId] ?? "deleted chat" : "deleted chat"}”`;
}

/** One note in Settings → Memory, as a card like a role's. */
export function MemoryNoteCard(props: {
  note: MemoryNoteSummary;
  roleLabels: Record<string, string>;
  chatTitles: Record<string, string>;
  onOpen: () => void;
}): JSX.Element {
  const { note } = props;
  const state = note.archivedAt ? `archived ${memoryDate(note.archivedAt)}` : note.awaitingRepository ? "waits for the repository" : "";
  return (
    <button type="button" className="roles-card memory-card" data-testid="memory-note" data-note-id={note.id} onClick={props.onOpen}>
      <span className="roles-card-head">
        <span className="roles-card-title-row">
          <strong title={note.title}>{note.title}</strong>
          <span className="roles-kind-badge is-built-in">{MEMORY_KIND_LABELS[note.kind]}</span>
        </span>
      </span>
      <span className="roles-card-summary">
        {memoryScopeLabel(note, props.roleLabels, props.chatTitles)}
        {note.tags.length > 0 && <span className="memory-card-tags">{` · ${note.tags.map((tag) => `#${tag}`).join(" ")}`}</span>}
      </span>
      <span className="roles-no-participants">
        <UserRound size={15} aria-hidden />
        <span className="memory-card-footer-text">
          @{note.author} · {memoryDate(note.updatedAt)}{state ? ` · ${state}` : ""}
        </span>
      </span>
    </button>
  );
}
