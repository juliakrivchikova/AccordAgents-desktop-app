import { useCallback, useMemo, useRef } from "react";

import type { AppSettings, Conversation, LocalFileOpenAction } from "../../../shared/types";
import { artifactMembersForConversation } from "../../../shared/artifacts";
import { ArtifactsPanel } from "../artifacts/artifacts-panel";
import type { ArtifactsState } from "../artifacts/use-artifacts";
import type { FileLinkRef } from "../content/local-file-link";
import { AttachmentPanel, FilePanel } from "../files/file-panel";
import { AttachmentPanelContext } from "../files/file-panel-context";

/**
 * What the chat's side panel shows (artifacts, a local file or an attached
 * image) and the way back to a thread a file was opened from. The panel and a
 * thread share the place on the right, so opening a file from a thread replaces
 * it, and "Back to thread" brings the same thread back where it was.
 */
export function useChatSidePanel(props: {
  artifacts: ArtifactsState;
  /** The chat view's root element (the thread's scroll position is read from it). */
  root: () => HTMLElement | null;
  selectThread: (rootId: string | undefined) => void;
}): {
  openInPanel: (ref: FileLinkRef) => void;
  attachmentContext: React.ContextType<typeof AttachmentPanelContext>;
  backToThread?: () => void;
} {
  const { artifacts, root, selectThread } = props;
  const threadScroll = useRef<{ rootId: string; scrollTop: number } | undefined>();

  const rememberThread = useCallback((rootId: string | undefined) => {
    if (!rootId) return;
    const body = root()?.querySelector<HTMLElement>(".chat-thread-body");
    threadScroll.current = { rootId, scrollTop: body?.scrollTop ?? 0 };
  }, [root]);

  const openInPanel = useCallback((ref: FileLinkRef) => {
    rememberThread(ref.returnThreadRootId);
    artifacts.openFile({
      path: ref.absolutePath ?? ref.path,
      line: ref.line,
      column: ref.column,
      returnThreadRootId: ref.returnThreadRootId
    });
  }, [artifacts.openFile, rememberThread]);

  const attachmentContext = useMemo(() => ({
    openAttachment: (target: Parameters<ArtifactsState["openAttachment"]>[0]) => {
      rememberThread(target.returnThreadRootId);
      artifacts.openAttachment(target);
    }
  }), [artifacts.openAttachment, rememberThread]);

  const returnThreadRootId = artifacts.fileTarget?.returnThreadRootId;
  const backToThread = returnThreadRootId ? () => {
    const saved = threadScroll.current?.rootId === returnThreadRootId ? threadScroll.current.scrollTop : undefined;
    artifacts.closePanel();
    selectThread(returnThreadRootId);
    if (saved !== undefined) {
      // The thread mounts on the next frame; put it back where it was.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const body = root()?.querySelector<HTMLElement>(".chat-thread-body");
        if (body) body.scrollTop = saved;
      }));
    }
  } : undefined;

  return { openInPanel, attachmentContext, backToThread };
}

export function ChatSidePanel(props: {
  conversation: Conversation;
  settings: AppSettings;
  artifacts: ArtifactsState;
  backToThread?: () => void;
  openFileOutside: (ref: FileLinkRef, action: LocalFileOpenAction) => void;
}): JSX.Element {
  const { artifacts } = props;
  const target = artifacts.fileTarget;
  if (target?.kind === "file") {
    return (
      <FilePanel
        // One panel per file: another line of the same file moves the editor, it does not reload.
        key={target.path}
        conversationId={props.conversation.id}
        target={target}
        externalAction={props.settings.repoFileExternalOpenAction}
        onClose={artifacts.closePanel}
        onBackToThread={props.backToThread}
        openOutside={props.openFileOutside}
      />
    );
  }
  if (target?.kind === "attachment") {
    return <AttachmentPanel key={target.attachmentId} target={target} onClose={artifacts.closePanel} onBackToThread={props.backToThread} />;
  }
  return (
    <ArtifactsPanel
      conversationId={props.conversation.id}
      members={artifactMembersForConversation(props.conversation)}
      artifacts={artifacts.artifacts}
      selectedId={artifacts.selectedId}
      onSelect={artifacts.selectArtifact}
      onClose={artifacts.closePanel}
    />
  );
}
