import { parseArtifactNoteCard, type ArtifactNoteCard } from "./artifactNoteCard";

// What an artifact note's card shows on its right: one mark per member whose
// draft or signature the artifact waits for, filled for those who had given
// it when the note was written (the User, 2026-11-07). Worked out from the
// notes themselves, in the order they were written, so an old note shows the
// moment it records, on the desktop and on the phone alike.

export interface ArtifactNoteProgress {
  kind: "drafts" | "signatures";
  /** Who had given theirs, in the order they did; "" where a note before the
   *  loaded part of the chat says someone did but not who. */
  done: string[];
  total: number;
  /** Every signature is in: the marks turn green. */
  complete: boolean;
}

export interface ArtifactNoteProgressInput {
  id: string;
  content: string;
}

/** What the desktop knows of an artifact now, when its notes do not say:
 *  how many signers it has (a revision keeps the signer set). */
export type ArtifactSignerCount = (artifactId: string) => number | undefined;

const COUNT = /^(?:Drafts )?(\d+)\/(\d+)(?: signed)?$/;

function countOf(details: string[], suffix: "Drafts" | "signed"): { done: number; total: number } | undefined {
  for (const detail of details) {
    const match = COUNT.exec(detail);
    if (match && detail.includes(suffix)) {
      return { done: Number(match[1]), total: Number(match[2]) };
    }
  }
  return undefined;
}

/** `done`, with unnamed places added when a note counts more than the
 *  loaded notes name. */
function padded(done: string[], count: number): string[] {
  return done.length >= count ? done : [...done, ...Array.from({ length: count - done.length }, () => "")];
}

/** The marks for every artifact note among `notes` (in timeline order),
 *  by note id; notes that are not about drafts or signatures get none. */
export function artifactNoteProgressById(
  notes: ArtifactNoteProgressInput[],
  signerCount?: ArtifactSignerCount
): Map<string, ArtifactNoteProgress> {
  const parsed: Array<{ id: string; card: ArtifactNoteCard }> = [];
  for (const note of notes) {
    const card = parseArtifactNoteCard(note.content);
    if (card) parsed.push({ id: note.id, card });
  }
  // A revision keeps the signer set, so any "k/N signed" note tells how many
  // signatures every published version of that artifact waits for.
  const signersByArtifact = new Map<string, number>();
  const draftersByArtifact = new Map<string, number>();
  for (const { card } of parsed) {
    const signed = countOf(card.details, "signed");
    if (signed) signersByArtifact.set(card.artifactId, signed.total);
    const drafts = countOf(card.details, "Drafts");
    if (drafts) draftersByArtifact.set(card.artifactId, drafts.total);
  }
  const signers = (artifactId: string): number | undefined =>
    signersByArtifact.get(artifactId) ?? signerCount?.(artifactId) ?? draftersByArtifact.get(artifactId);

  const drafts = new Map<string, string[]>();
  const signatures = new Map<string, string[]>();
  const result = new Map<string, ArtifactNoteProgress>();
  for (const { id, card } of parsed) {
    const artifactId = card.artifactId;
    switch (card.action) {
      case "created-collection": {
        const count = countOf(card.details, "Drafts");
        drafts.set(artifactId, []);
        if (count && count.total > 0) result.set(id, { kind: "drafts", done: [], total: count.total, complete: false });
        break;
      }
      case "submitted-draft":
      case "withdrew-draft": {
        const current = (drafts.get(artifactId) ?? []).filter((actor) => actor !== card.actor);
        const next = card.action === "submitted-draft" ? [...current, card.actor] : current;
        drafts.set(artifactId, next);
        const total = Math.max(draftersByArtifact.get(artifactId) ?? 0, next.length);
        if (total > 0) result.set(id, { kind: "drafts", done: next, total, complete: false });
        break;
      }
      case "published":
      case "revised": {
        // A new version: the signatures given to the last one no longer count.
        signatures.set(artifactId, []);
        const total = signers(artifactId);
        if (total && total > 0) result.set(id, { kind: "signatures", done: [], total, complete: false });
        break;
      }
      case "signed": {
        const current = (signatures.get(artifactId) ?? []).filter((actor) => actor !== card.actor);
        let done = [...current, card.actor];
        const count = countOf(card.details, "signed");
        const fully = card.details.includes("fully approved");
        const total = count?.total ?? signers(artifactId) ?? done.length;
        if (count) done = padded(done, count.done);
        if (fully) done = padded(done, total);
        signatures.set(artifactId, done);
        if (total > 0) result.set(id, { kind: "signatures", done: done.slice(0, total), total, complete: fully || done.length >= total });
        break;
      }
      default:
        break;
    }
  }
  return result;
}
