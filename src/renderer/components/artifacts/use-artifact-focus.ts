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
 * version, a member's draft), once per request. A version is shown at once;
 * a draft once the document's drafts are read (a published document's list
 * comes a moment after it), and the document as it is when the author has
 * none to show.
 */
export function useArtifactFocus(props: {
  focus?: ArtifactFocusRequest;
  selectedId?: string;
  headVersion?: number;
  detail?: ArtifactReadResult;
  drafts: readonly ArtifactDraftView[];
  /** The document the `drafts` list was read for, once it was. */
  draftsFor?: string;
  draftsFailed: boolean;
  showVersion: (version: number | undefined) => void;
  showDraft: (draftId: string) => void;
}): void {
  const { focus, selectedId } = props;
  const [pendingAuthor, setPendingAuthor] = useState<{ artifactId: string; author: string }>();
  useEffect(() => {
    if (!focus || focus.artifactId !== selectedId) return;
    if ("version" in focus) {
      setPendingAuthor(undefined);
      // The newest version is the document as it is, which follows a newer one.
      props.showVersion(focus.version === props.headVersion ? undefined : focus.version);
    } else {
      setPendingAuthor({ artifactId: focus.artifactId, author: focus.draftAuthor });
    }
    // Once per request: a request is new when its seq is.
  }, [focus?.seq, selectedId]);
  const { detail, drafts, draftsFor, draftsFailed } = props;
  useEffect(() => {
    if (!pendingAuthor) return;
    if (pendingAuthor.artifactId !== selectedId) {
      setPendingAuthor(undefined);
      return;
    }
    if (!detail || detail.summary.id !== pendingAuthor.artifactId) return;
    const collecting = detail.lifecycle === "collecting_drafts";
    if (!collecting && draftsFor !== detail.summary.id && !draftsFailed) return;
    const draft = submittedDraftOf(collecting ? detail.drafts : drafts, pendingAuthor.author);
    setPendingAuthor(undefined);
    if (draft) props.showDraft(draft.id);
  }, [pendingAuthor, selectedId, detail, drafts, draftsFor, draftsFailed]);
}
