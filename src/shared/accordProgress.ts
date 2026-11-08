import { accordLaunchCardForMessage, type AccordLaunchCard } from "./accordLaunchCard";
import { parseArtifactNoteCard, type ArtifactNoteCard } from "./artifactNoteCard";
import { ARTIFACT_NOTE_MESSAGE_SOURCE } from "./artifacts";

// One card per Accord (the User, 2026-11-08): the launch card shows where the
// Accord stands, worked out from the artifact notes of its document, and
// the notes of every Accord's document leave the timeline. The app files a note under the launch
// (metadata.accordLaunchMessageId) when the facilitator's document records
// the launch it was started for; that names the document, and every note of
// that document counts, also one written without the link (a device on an
// older version, a copy that failed to update). The card pinned above the
// composer shows the chat's newest Accord; the others are in their documents.
// The same reading on the desktop and the phone, over the same notes, so the
// two cannot drift apart. Accords from before the link keep their notes.

export type AccordStepState = "done" | "active" | "todo";

export interface AccordProgress {
  artifactId: string;
  /** The document's name as the newest note gives it. */
  title: string;
  /** Who writes a draft (the facilitator and every member, as the Accord
   *  skill sets it up) and who has submitted one. */
  drafts: { authors: string[]; submitted: string[]; state: AccordStepState };
  /** The newest published version, once there is one. */
  version?: { number: number; author: string; note?: string };
  publishState: AccordStepState;
  /** Who signs: the Accord's people and anyone else who signed; `total` is
   *  the count the notes give (it can name signers the card does not). */
  signatures: { signers: string[]; signed: string[]; given: number; total: number; state: AccordStepState };
  reached: boolean;
}

export interface AccordNoteInput {
  content: string;
  accordLaunchMessageId?: unknown;
  /** Who leads the Accord and who is in it, as the note carries them. */
  accordLaunch?: unknown;
  createdAt?: string;
}

export interface AccordLaunchInput {
  id: string;
  card: AccordLaunchCard;
  createdAt: string;
}

export interface DockedAccord {
  launchId: string;
  card: AccordLaunchCard;
  progress: AccordProgress;
}

function launchFromNote(value: unknown): AccordLaunchCard | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { facilitator, members } = value as { facilitator?: unknown; members?: unknown };
  return typeof facilitator === "string" && facilitator && Array.isArray(members) && members.every((member) => typeof member === "string")
    ? { facilitator, members: members as string[], subject: "" }
    : undefined;
}

/** The Accord pinned above the composer: the chat's newest one, whether its
 *  launch is among the loaded messages or only its notes are (a long chat).
 *  Undefined while the newest Accord has no document yet: a finished older
 *  one does not stand in for it. */
export function dockedAccordFrom(launches: AccordLaunchInput[], notes: AccordNoteInput[]): DockedAccord | undefined {
  const candidates = new Map<string, { card: AccordLaunchCard; at: string }>();
  for (const launch of launches) candidates.set(launch.id, { card: launch.card, at: launch.createdAt });
  for (const note of notes) {
    const id = typeof note.accordLaunchMessageId === "string" ? note.accordLaunchMessageId : "";
    const card = id && !candidates.has(id) ? launchFromNote(note.accordLaunch) : undefined;
    if (card) candidates.set(id, { card, at: note.createdAt ?? "" });
  }
  let newest: { id: string; card: AccordLaunchCard; at: string } | undefined;
  for (const [id, candidate] of candidates) {
    if (!newest || candidate.at >= newest.at) newest = { id, ...candidate };
  }
  if (!newest) return undefined;
  const progress = accordProgressFromNotes(newest.id, newest.card, notes);
  return progress ? { launchId: newest.id, card: newest.card, progress } : undefined;
}

const VERSION = /^v(\d+)$/;
const SIGNED_COUNT = /^(\d+)\/(\d+) signed$/;

function parsedNotes(notes: AccordNoteInput[]): Array<{ note: ArtifactNoteCard; launchId?: string }> {
  const result: Array<{ note: ArtifactNoteCard; launchId?: string }> = [];
  for (const input of notes) {
    const note = parseArtifactNoteCard(input.content);
    if (note) {
      result.push({ note, ...(typeof input.accordLaunchMessageId === "string" && input.accordLaunchMessageId ? { launchId: input.accordLaunchMessageId } : {}) });
    }
  }
  return result;
}

/** The document each launch's card shows, by launch id: the newest draft
 *  collection filed under it (or, without one in the list, the newest
 *  document any of its notes names). */
function documentsByLaunch(notes: Array<{ note: ArtifactNoteCard; launchId?: string }>): Map<string, string> {
  const byLaunch = new Map<string, string>();
  for (const { note, launchId } of notes) {
    if (launchId && (note.action === "created-collection" || !byLaunch.has(launchId))) {
      byLaunch.set(launchId, note.artifactId);
    }
  }
  return byLaunch;
}

/** The Accord's progress from the chat's artifact notes, read in the order
 *  given (the timeline's). Undefined while no note is filed under it. */
export function accordProgressFromNotes(
  launchMessageId: string,
  card: AccordLaunchCard,
  notes: AccordNoteInput[]
): AccordProgress | undefined {
  const parsed = parsedNotes(notes);
  const artifactId = documentsByLaunch(parsed).get(launchMessageId);
  if (!artifactId) return undefined;
  const people = uniqueHandles([card.facilitator, ...card.members]);
  let title = "";
  const submitted: string[] = [];
  let version: AccordProgress["version"];
  let signed: string[] = [];
  let signedCount: { done: number; total: number } | undefined;
  let fullyApproved = false;
  for (const { note } of parsed) {
    if (note.artifactId !== artifactId) continue;
    title = note.label;
    const number = Number(VERSION.exec(note.details.find((detail) => VERSION.test(detail)) ?? "")?.[1] ?? NaN);
    switch (note.action) {
      case "submitted-draft":
        if (!submitted.includes(note.actor)) submitted.push(note.actor);
        break;
      case "withdrew-draft": {
        const index = submitted.indexOf(note.actor);
        if (index >= 0) submitted.splice(index, 1);
        break;
      }
      case "published":
      case "created":
      case "revised":
        if (Number.isFinite(number)) {
          // A new version waits for every signature again.
          version = { number, author: note.actor, ...(note.note ? { note: note.note } : {}) };
          signed = [];
          signedCount = undefined;
          fullyApproved = false;
        }
        break;
      case "signed": {
        // A signature counts only on the version waiting for it.
        if (!version || number !== version.number) break;
        if (!signed.includes(note.actor)) signed.push(note.actor);
        const count = note.details.map((detail) => SIGNED_COUNT.exec(detail)).find(Boolean);
        if (count) signedCount = { done: Number(count[1]), total: Number(count[2]) };
        if (note.details.includes("fully approved")) fullyApproved = true;
        break;
      }
      default:
        break;
    }
  }
  const allSubmitted = people.every((person) => submitted.includes(person));
  // Reached is what the document says: every required signature is in. The
  // card's people are not always the whole signer set (the User may approve
  // another signer), so it is never inferred from them.
  const reached = Boolean(version) && (fullyApproved || Boolean(signedCount && signedCount.done >= signedCount.total));
  const signers = uniqueHandles([...people, ...signed]);
  const total = Math.max(signedCount?.total ?? 0, signers.length);
  return {
    artifactId,
    title,
    drafts: {
      authors: people,
      submitted: people.filter((person) => submitted.includes(person)),
      state: version || allSubmitted ? "done" : "active"
    },
    ...(version ? { version } : {}),
    publishState: version ? "done" : allSubmitted ? "active" : "todo",
    signatures: {
      signers,
      signed: reached ? signers : signers.filter((person) => signed.includes(person)),
      given: reached ? total : Math.max(signedCount?.done ?? 0, signed.length),
      total,
      state: reached ? "done" : version ? "active" : "todo"
    },
    reached
  };
}

/** The short state the card shows by its title: "Drafts 1/2", "v2 · 1/2 signed", "Signed 2/2". */
export function accordProgressStatus(progress: AccordProgress): string {
  const { total } = progress.signatures;
  if (progress.reached) return `Signed ${total}/${total}`;
  if (progress.version) return `v${progress.version.number} · ${progress.signatures.given}/${total} signed`;
  return `Drafts ${progress.drafts.submitted.length}/${progress.drafts.authors.length}`;
}

export interface AccordStageMember {
  handle: string;
  given: boolean;
  waiting: boolean;
}

export interface AccordStage {
  key: "drafts" | "publish" | "signatures" | "reached";
  state: AccordStepState;
  label: string;
  detail?: string;
  members: AccordStageMember[];
}

/** The card's stages in order, with their words: the same on both screens. */
export function accordProgressStages(progress: AccordProgress): AccordStage[] {
  const { drafts, version, signatures } = progress;
  const draftsDone = drafts.state === "done";
  return [
    {
      key: "drafts",
      state: drafts.state,
      label: "Drafts",
      detail: draftsDone ? "Each member answered without seeing the others" : "Each member answers without seeing the others",
      members: drafts.authors.map((handle) => ({ handle, given: drafts.submitted.includes(handle), waiting: !draftsDone }))
    },
    {
      key: "publish",
      state: progress.publishState,
      label: version ? `v${version.number} published` : "Publish",
      ...(version ? { detail: `by @${version.author}` } : {}),
      members: []
    },
    {
      key: "signatures",
      state: signatures.state,
      label: "Signatures",
      members: version
        ? signatures.signers.map((handle) => ({ handle, given: signatures.signed.includes(handle), waiting: signatures.state === "active" }))
        : []
    },
    { key: "reached", state: progress.reached ? "done" : "todo", label: "Accord reached", members: [] }
  ];
}

/** The line over the version's note: "v2 · note by @fable"; a version
 *  published without a note just names itself ("v2 by @fable"). */
export function accordProgressNoteHead(version: NonNullable<AccordProgress["version"]>): string {
  return version.note ? `v${version.number} · note by @${version.author}` : `v${version.number} by @${version.author}`;
}

export interface AccordFoldInput extends AccordNoteInput {
  key: string;
}

/** Keys of the notes that leave the timeline: every note of a document
 *  filed under an Accord (the User, 2026-11-08: pinned, closed or older, an
 *  Accord's steps are on its card or in its document, never in the chat),
 *  also one written without the link. */
export function accordFoldedNoteKeys(notes: AccordFoldInput[]): Set<string> {
  const parsed = notes.flatMap((input) => {
    const note = parseArtifactNoteCard(input.content);
    return note ? [{ key: input.key, artifactId: note.artifactId, linked: typeof input.accordLaunchMessageId === "string" && Boolean(input.accordLaunchMessageId) }] : [];
  });
  const documents = new Set(parsed.filter((note) => note.linked).map((note) => note.artifactId));
  return new Set(parsed.filter((note) => documents.has(note.artifactId)).map((note) => note.key));
}

type FoldMessage = {
  id: string;
  role: string;
  content: string;
  createdAt: string;
  metadata?: {
    appMessageSource?: string;
    accordLaunchMessageId?: string;
    accordLaunch?: unknown;
    imageAttachments?: unknown[];
    repoFileMentions?: unknown[];
  };
};

/** The pinned Accord of a chat's loaded messages. */
export function dockedAccordOfMessages(messages: readonly FoldMessage[]): DockedAccord | undefined {
  const launches: AccordLaunchInput[] = [];
  const notes: AccordFoldInput[] = [];
  for (const message of messages) {
    if (message.role === "system" && message.metadata?.appMessageSource === ARTIFACT_NOTE_MESSAGE_SOURCE) {
      notes.push({
        key: message.id, content: message.content, createdAt: message.createdAt,
        accordLaunchMessageId: message.metadata.accordLaunchMessageId, accordLaunch: message.metadata.accordLaunch
      });
    } else if (message.role === "user") {
      const card = accordLaunchCardForMessage(message);
      if (card) launches.push({ id: message.id, card, createdAt: message.createdAt });
    }
  }
  return notes.some((note) => note.accordLaunchMessageId) ? dockedAccordFrom(launches, notes) : undefined;
}

// Worked out once per message list, not once per message asked about.
const foldedByMessages = new WeakMap<readonly FoldMessage[], Set<string>>();

/** Ids of a chat's loaded messages that leave the timeline: the notes of
 *  every Accord's document (accordFoldedNoteKeys). */
export function accordFoldedMessageIds(messages: readonly FoldMessage[]): Set<string> {
  let ids = foldedByMessages.get(messages);
  if (!ids) {
    ids = accordFoldedNoteKeys(messages
      .filter((message) => message.role === "system" && message.metadata?.appMessageSource === ARTIFACT_NOTE_MESSAGE_SOURCE)
      .map((message) => ({ key: message.id, content: message.content, accordLaunchMessageId: message.metadata?.accordLaunchMessageId })));
    foldedByMessages.set(messages, ids);
  }
  return ids;
}

function uniqueHandles(handles: string[]): string[] {
  const result: string[] = [];
  for (const handle of handles) {
    const normalized = handle.trim().replace(/^@/, "").toLowerCase();
    if (normalized && !result.includes(normalized)) result.push(normalized);
  }
  return result;
}
