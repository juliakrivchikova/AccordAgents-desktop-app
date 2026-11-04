import { ARTIFACT_USER_MEMBER } from "./types";

// The card the timeline shows for an artifact note. The note itself stays the
// one sentence ArtifactService writes ("@taylor revised [Plan](#artifact:id) ·
// v4 — note"), because that sentence is what members read as chat context;
// only the screen turns it into a card, on the desktop and on the phone alike.
// Notes already in the User's chats have the same sentences (unchanged since
// 2026-07-11), so they become cards too.

export type ArtifactNoteAction =
  | "created"
  | "created-collection"
  | "revised"
  | "renamed"
  | "signed"
  | "archived"
  | "restored"
  | "submitted-draft"
  | "withdrew-draft"
  | "published";

export interface ArtifactNoteCard {
  /** "user" for the User, otherwise the member's handle without "@". */
  actor: string;
  action: ArtifactNoteAction;
  artifactId: string;
  /** The name when the note was written; a screen that knows the current name shows that instead. */
  label: string;
  /** Short facts after the verb, in order: "v4", "fully approved", "was \"Old\"", "Drafts 0/2". */
  details: string[];
  /** What the member wrote about a revision. */
  note?: string;
}

const ACTION_BY_PHRASE: Record<string, ArtifactNoteAction> = {
  "created draft collection": "created-collection",
  "created artifact": "created",
  revised: "revised",
  "renamed artifact": "renamed",
  signed: "signed",
  "archived artifact": "archived",
  "restored artifact": "restored",
  "submitted a draft to": "submitted-draft",
  "withdrew a draft from": "withdrew-draft",
  published: "published"
};

// Built from ACTION_BY_PHRASE, the one list of the sentences' verbs.
const NOTE_PATTERN = new RegExp(
  "^(User|@\\S+) " +
  `(${Object.keys(ACTION_BY_PHRASE).join("|")}) ` +
  "\\[([^\\]]*)\\]\\(#artifact:([^)\\s]+)\\)" +
  "(.*)$",
  "s"
);

const VERB_BY_ACTION: Record<ArtifactNoteAction, string> = {
  created: "created",
  "created-collection": "created a draft collection",
  revised: "revised",
  renamed: "renamed",
  signed: "signed",
  archived: "archived",
  restored: "restored",
  "submitted-draft": "submitted a draft",
  "withdrew-draft": "withdrew a draft",
  published: "published"
};

/** What follows the reference, per action; anything else is not a note this parser knows. */
function noteTail(action: ArtifactNoteAction, tail: string): Pick<ArtifactNoteCard, "details" | "note"> | undefined {
  switch (action) {
    case "revised": {
      const match = /^ · (v\d+)(?: — (.+))?$/s.exec(tail);
      return match ? { details: [match[1]!], ...(match[2]?.trim() ? { note: match[2].trim() } : {}) } : undefined;
    }
    case "created":
    case "published":
    case "created-collection": {
      const match = /^ · (v\d+|Drafts \d+\/\d+)$/.exec(tail);
      return match ? { details: [match[1]!] } : undefined;
    }
    case "signed": {
      const match = /^ (v\d+)(?: \(([^()]+)\))?$/.exec(tail);
      return match ? { details: match[2] ? [match[1]!, match[2]] : [match[1]!] } : undefined;
    }
    case "renamed": {
      const match = /^ \(was "(.*)"\)$/s.exec(tail);
      return match ? { details: [`was "${match[1]}"`] } : undefined;
    }
    case "submitted-draft":
      return tail === " · Submitted" ? { details: [] } : undefined;
    case "withdrew-draft":
      return tail === " · Withdrawn" ? { details: [] } : undefined;
    case "archived":
    case "restored":
      return tail === "" ? { details: [] } : undefined;
  }
}

/** The card for an artifact note's text, or undefined when the text is not one. */
export function parseArtifactNoteCard(content: unknown): ArtifactNoteCard | undefined {
  if (typeof content !== "string") {
    return undefined;
  }
  const match = NOTE_PATTERN.exec(content.trim());
  if (!match) {
    return undefined;
  }
  const action = ACTION_BY_PHRASE[match[2]!];
  const artifactId = match[4]!;
  if (!action || !artifactId) {
    return undefined;
  }
  const tail = noteTail(action, match[5]!);
  if (!tail) {
    return undefined;
  }
  const actor = match[1] === "User" ? ARTIFACT_USER_MEMBER : match[1]!.slice(1).toLowerCase();
  // The service writes the User as "User", never "@user": a sentence naming
  // "@user" is not one it wrote, and must not read as "You".
  if (actor === ARTIFACT_USER_MEMBER && match[1] !== "User") {
    return undefined;
  }
  return { actor, action, artifactId, label: match[3]!.trim() || "artifact", ...tail };
}

/** The verb the card shows after who did it: "revised", "submitted a draft". */
export function artifactNoteVerb(action: ArtifactNoteAction): string {
  return VERB_BY_ACTION[action];
}

/** Who did it, as the card names them: "You" for the User, the Chat Assistant
 *  by that name (as chatParticipantReference does), any other member by handle. */
export function artifactNoteActorLabel(actor: string): string {
  if (actor === ARTIFACT_USER_MEMBER) {
    return "You";
  }
  return actor === "assistant" || actor === "admin" ? "Chat Assistant" : `@${actor}`;
}
