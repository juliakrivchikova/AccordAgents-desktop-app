import { useEffect, useState } from "react";

import type { ArtifactDraftView, ArtifactReadResult } from "../../../shared/types";
import type { ArtifactFocusRequest } from "./use-artifacts";

const authorKey = (author: string): string => author.trim().replace(/^@/, "").toLowerCase();

/** The draft an author submitted to a document: the one waiting to be
 *  considered (an author has one at a time), else the newest it submitted
 *  before replacing it; none while it has submitted nothing. */
export function submittedDraftOf(drafts: readonly ArtifactDraftView[], author: string): ArtifactDraftView | undefined {
  const key = authorKey(author);
  const own = drafts.filter((draft) => authorKey(draft.author) === key && draft.submittedAt);
  return own.find((draft) => draft.state === "submitted")
    ?? own.reduce<ArtifactDraftView | undefined>((newest, draft) => !newest || (draft.submittedAt ?? "") > (newest.submittedAt ?? "") ? draft : newest, undefined);
}

/**
 * Lands the panel on the place an open asked for (an Accord's card: a
 * version, a member's draft), once per open. A version is shown at once. A
 * draft is looked for in the drafts read after the click (the document is
 * read again for it: a draft submitted a moment ago is in a list the panel
 * has not read yet); the document is shown as it is when the author has
 * none. A form on screen (a revision she is typing) is never replaced, as the
 * panel's own pickers wait for it too, and anything she does in the panel
 * meanwhile (`cancel`) or another open stops the wait for a draft.
 */
export function useArtifactFocus(props: {
  focus?: ArtifactFocusRequest;
  takeFocus: (seq: number) => boolean;
  selectedId?: string;
  /** A form is on screen (revising, creating). */
  editing: boolean;
  headVersion?: number;
  detail?: ArtifactReadResult;
  drafts: readonly ArtifactDraftView[];
  /** The document the `drafts` list was read for, once it was. */
  draftsFor?: string;
  /** Why the last read of the drafts failed; a new value for every failure. */
  draftError?: unknown;
  showVersion: (version: number | undefined) => void;
  showDraft: (draftId: string) => void;
  /** Reads the selected document (one version of it) and its drafts again. */
  reload: (version?: number) => void;
}): { cancel: () => void } {
  const { focus, selectedId, detail, drafts, draftsFor, draftError, editing } = props;
  // The drafts as they were at the click: only a read after it answers.
  const [pending, setPending] = useState<{ artifactId: string; author: string; drafts: readonly ArtifactDraftView[]; draftError: unknown }>();
  useEffect(() => {
    if (!focus) {
      setPending(undefined);
      return;
    }
    if (focus.artifactId !== selectedId || !props.takeFocus(focus.seq)) return;
    setPending(undefined);
    const place = focus.place;
    if (!place || editing) return;
    if ("version" in place) {
      // The newest version is the document as it is, which follows a newer one.
      const head = Math.max(props.headVersion ?? 0, detail?.summary.id === focus.artifactId ? detail.summary.headVersion : 0);
      const target = place.version === head ? undefined : place.version;
      props.showVersion(target);
      props.reload(target);
      return;
    }
    setPending({ artifactId: focus.artifactId, author: place.draftAuthor, drafts, draftError });
    // Under the draft, the document as it is (no older version pinned).
    props.showVersion(undefined);
    props.reload();
    // Once per open: an open is new when its seq is.
  }, [focus?.seq, selectedId]);
  useEffect(() => {
    if (!pending) return;
    if (pending.artifactId !== selectedId || editing) {
      setPending(undefined);
      return;
    }
    if (drafts === pending.drafts && draftError === pending.draftError) return;
    if (!detail || detail.summary.id !== pending.artifactId || draftsFor !== pending.artifactId) return;
    const draft = submittedDraftOf(detail.lifecycle === "collecting_drafts" ? detail.drafts : drafts, pending.author);
    setPending(undefined);
    if (draft) props.showDraft(draft.id);
  }, [pending, selectedId, detail, drafts, draftsFor, draftError, editing]);
  return { cancel: () => setPending(undefined) };
}
