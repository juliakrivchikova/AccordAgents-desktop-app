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
 * version, a member's draft), once per request. A version is shown at once.
 * A draft is looked for in the drafts read after the click (the document is
 * read again for it: a draft submitted a moment ago is in a list the panel
 * has not read yet); the document is shown as it is when the author has none.
 */
export function useArtifactFocus(props: {
  focus?: ArtifactFocusRequest;
  selectedId?: string;
  headVersion?: number;
  detail?: ArtifactReadResult;
  drafts: readonly ArtifactDraftView[];
  /** The document the `drafts` list was read for, once it was. */
  draftsFor?: string;
  /** Why the last read of the drafts failed; a new value for every failure. */
  draftError?: unknown;
  showVersion: (version: number | undefined) => void;
  showDraft: (draftId: string) => void;
  /** Reads the selected document and its drafts again. */
  reload: () => void;
}): void {
  const { focus, selectedId, detail, drafts, draftsFor, draftError } = props;
  // The drafts as they were at the click: only a read after it answers.
  const [pending, setPending] = useState<{ artifactId: string; author: string; drafts: readonly ArtifactDraftView[]; draftError: unknown }>();
  useEffect(() => {
    if (!focus || focus.artifactId !== selectedId) return;
    if ("version" in focus) {
      setPending(undefined);
      // The newest version is the document as it is, which follows a newer one.
      props.showVersion(focus.version === props.headVersion ? undefined : focus.version);
      return;
    }
    setPending({ artifactId: focus.artifactId, author: focus.draftAuthor, drafts, draftError });
    // Under the draft, the document as it is (no older version pinned).
    props.showVersion(undefined);
    props.reload();
    // Once per request: a request is new when its seq is.
  }, [focus?.seq, selectedId]);
  useEffect(() => {
    if (!pending) return;
    if (pending.artifactId !== selectedId) {
      setPending(undefined);
      return;
    }
    if (drafts === pending.drafts && draftError === pending.draftError) return;
    if (!detail || detail.summary.id !== pending.artifactId || draftsFor !== pending.artifactId) return;
    const draft = submittedDraftOf(detail.lifecycle === "collecting_drafts" ? detail.drafts : drafts, pending.author);
    setPending(undefined);
    if (draft) props.showDraft(draft.id);
  }, [pending, selectedId, detail, drafts, draftsFor, draftError]);
}
