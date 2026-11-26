import { useEffect, useRef, type MutableRefObject, type ReactNode } from "react";
import { FilesIcon, FileTextIcon } from "@phosphor-icons/react";

import type {
  ArtifactSummary,
  ChatParticipant,
  RepoFileSearchResult
} from "../../../shared/types";
import { artifactSummaryStatusLabel } from "../../../shared/artifacts";
import { chatParticipantDisplayName } from "../conversation/conversation-display";
import { repoFileBasename } from "./chat-composer-draft-utils";
import { ChatSlashMenu, type ChatSlashMenuProps } from "./chat-slash-menu";

export function ChatComposerMenus(props: {
  artifactOptions?: ArtifactSummary[];
  fileIndex: number;
  insertArtifactMention?: (artifact: ArtifactSummary) => void;
  insertFileMention: (file: RepoFileSearchResult) => void;
  insertMention: (participant: ChatParticipant) => void;
  mentionIndex: number;
  mentionOptions: ChatParticipant[];
  participantRoleLabel: (participant: ChatParticipant) => string;
  renderParticipantAvatar: (participant: ChatParticipant) => ReactNode;
  slashMenu?: ChatSlashMenuProps;
  visibleFileOptions: RepoFileSearchResult[];
}): JSX.Element {
  const mentionRefs = useActiveOptionScroll(props.mentionIndex, props.mentionOptions.length);
  // Artifacts and repository files share the "#" popover and one index space.
  const artifactOptions = props.artifactOptions ?? [];
  const hashOptionCount = artifactOptions.length + props.visibleFileOptions.length;
  const fileRefs = useActiveOptionScroll(props.fileIndex, hashOptionCount);

  return (
    <>
      {props.mentionOptions.length > 0 && (
        <div className="mention-menu member-mention-menu" role="listbox" aria-label="Members">
          <div className="chat-popover-section-title">Members</div>
          {props.mentionOptions.map((participant, index) => (
            <button
              ref={setOptionRef(mentionRefs, index)}
              className={index === props.mentionIndex ? "selected" : ""}
              onMouseDown={(event) => {
                event.preventDefault();
                props.insertMention(participant);
              }}
              role="option"
              aria-selected={index === props.mentionIndex}
              key={participant.id}
            >
              {props.renderParticipantAvatar(participant)}
              <strong>{chatParticipantDisplayName(participant)}</strong>
              <span>{props.participantRoleLabel(participant)}</span>
              {index === 0 && <kbd>Enter</kbd>}
            </button>
          ))}
        </div>
      )}
      {hashOptionCount > 0 && (
        <div
          className="mention-menu file-mention-menu"
          role="listbox"
          aria-label={artifactOptions.length > 0
            ? (props.visibleFileOptions.length > 0 ? "Artifacts and repository files" : "Artifacts")
            : "Repository files"}
        >
          {artifactOptions.length > 0 && <div className="chat-popover-section-title">Artifacts</div>}
          {artifactOptions.map((artifact, index) => (
            <button
              ref={setOptionRef(fileRefs, index)}
              className={index === props.fileIndex ? "selected" : ""}
              onMouseDown={(event) => {
                event.preventDefault();
                props.insertArtifactMention?.(artifact);
              }}
              role="option"
              aria-selected={index === props.fileIndex}
              key={artifact.id}
            >
              <span className="file-mention-icon"><FilesIcon size={18} /></span>
              <strong>{artifact.name}</strong>
              <span>{artifactSummaryStatusLabel(artifact)}</span>
              {index === 0 && <kbd>Enter</kbd>}
            </button>
          ))}
          {props.visibleFileOptions.length > 0 && <div className="chat-popover-section-title">Repository files</div>}
          {props.visibleFileOptions.map((file, index) => {
            const optionIndex = artifactOptions.length + index;
            return (
              <button
                ref={setOptionRef(fileRefs, optionIndex)}
                className={optionIndex === props.fileIndex ? "selected" : ""}
                onMouseDown={(event) => {
                  event.preventDefault();
                  props.insertFileMention(file);
                }}
                role="option"
                aria-selected={optionIndex === props.fileIndex}
                key={file.path}
              >
                <span className="file-mention-icon"><FileTextIcon size={18} /></span>
                <strong>{repoFileBasename(file.path)}</strong>
                <span>{file.path}</span>
                {optionIndex === 0 && <kbd>Enter</kbd>}
              </button>
            );
          })}
        </div>
      )}
      {props.slashMenu && <ChatSlashMenu {...props.slashMenu} />}
    </>
  );
}

function useActiveOptionScroll(activeIndex: number, optionCount: number): MutableRefObject<Array<HTMLButtonElement | null>> {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    refs.current.length = optionCount;
    const selected = refs.current[activeIndex];
    if (!selected) {
      return;
    }
    selected.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeIndex, optionCount]);

  return refs;
}

function setOptionRef(
  refs: MutableRefObject<Array<HTMLButtonElement | null>>,
  index: number
): (node: HTMLButtonElement | null) => void {
  return (node) => {
    refs.current[index] = node;
  };
}
