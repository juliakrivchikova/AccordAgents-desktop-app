import { useEffect, useRef, type MutableRefObject, type ReactNode } from "react";
import { FileText, ListChecks, Minimize2 } from "lucide-react";

import type {
  ChatParticipant,
  ChatSavedPromptConfig,
  RepoFileSearchResult,
  UserSkillSummary
} from "../../../shared/types";
import { chatParticipantDisplayName } from "../conversation/conversation-display";
import { providerLabel } from "./chat-conversation-data";
import {
  repoFileBasename,
  type SlashCommandOption
} from "./chat-composer-draft-utils";

export function ChatComposerMenus(props: {
  fileIndex: number;
  insertCompactCommand: () => void;
  insertFileMention: (file: RepoFileSearchResult) => void;
  insertMention: (participant: ChatParticipant) => void;
  insertSavedPrompt: (prompt: ChatSavedPromptConfig) => void;
  insertSkillMention: (skill: UserSkillSummary) => void;
  mentionIndex: number;
  mentionOptions: ChatParticipant[];
  participantRoleLabel: (participant: ChatParticipant) => string;
  renderParticipantAvatar: (participant: ChatParticipant) => ReactNode;
  slashMenuPlacement?: "above" | "below";
  skillIndex: number;
  skillQuery: string | undefined;
  skillTargetLabel?: string;
  visibleCommandOptions: SlashCommandOption[];
  visibleFileOptions: RepoFileSearchResult[];
  visiblePromptOptions: ChatSavedPromptConfig[];
  visibleSkillOptions: UserSkillSummary[];
}): JSX.Element {
  const mentionRefs = useActiveOptionScroll(props.mentionIndex, props.mentionOptions.length);
  const fileRefs = useActiveOptionScroll(props.fileIndex, props.visibleFileOptions.length);
  const slashOptionCount = props.visibleCommandOptions.length + props.visiblePromptOptions.length + props.visibleSkillOptions.length;
  const slashRefs = useActiveOptionScroll(props.skillIndex, slashOptionCount);
  const slashMenuClassName = [
    "mention-menu",
    "skill-mention-menu",
    props.slashMenuPlacement === "below" ? "opens-below" : ""
  ].filter(Boolean).join(" ");

  return (
    <>
      {props.mentionOptions.length > 0 && (
        <div className="mention-menu" role="listbox" aria-label="Members">
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
      {props.visibleFileOptions.length > 0 && (
        <div className="mention-menu file-mention-menu" role="listbox" aria-label="Repository files">
          <div className="chat-popover-section-title">Repository files</div>
          {props.visibleFileOptions.map((file, index) => (
            <button
              ref={setOptionRef(fileRefs, index)}
              className={index === props.fileIndex ? "selected" : ""}
              onMouseDown={(event) => {
                event.preventDefault();
                props.insertFileMention(file);
              }}
              role="option"
              aria-selected={index === props.fileIndex}
              key={file.path}
            >
              <span className="file-mention-icon"><FileText size={18} /></span>
              <strong>{repoFileBasename(file.path)}</strong>
              <span>{file.path}</span>
              {index === 0 && <kbd>Enter</kbd>}
            </button>
          ))}
        </div>
      )}
      {props.skillQuery !== undefined && (
        props.visibleCommandOptions.length > 0 ||
        props.visiblePromptOptions.length > 0 ||
        props.visibleSkillOptions.length > 0 ||
        props.skillTargetLabel
      ) && (
        <div className={slashMenuClassName} role="listbox" aria-label="Slash commands, prompts, and skills">
          <div className="chat-popover-section-title">Slash</div>
          {props.skillTargetLabel && <div className="skill-mention-menu-context">{props.skillTargetLabel}</div>}
          {props.visibleCommandOptions.map((command, index) => (
            <button
              ref={setOptionRef(slashRefs, index)}
              className={index === props.skillIndex ? "selected" : ""}
              onMouseDown={(event) => {
                event.preventDefault();
                props.insertCompactCommand();
              }}
              role="option"
              aria-selected={index === props.skillIndex}
              key={command.id}
            >
              <span className="file-mention-icon"><Minimize2 size={18} /></span>
              <strong>{command.label}</strong>
              <span>{command.description}</span>
              <small>Command</small>
              {index === 0 && <kbd>Enter</kbd>}
            </button>
          ))}
          {props.visiblePromptOptions.map((prompt, index) => {
            const optionIndex = props.visibleCommandOptions.length + index;
            return (
              <button
                ref={setOptionRef(slashRefs, optionIndex)}
                className={optionIndex === props.skillIndex ? "selected" : ""}
                onMouseDown={(event) => {
                  event.preventDefault();
                  props.insertSavedPrompt(prompt);
                }}
                role="option"
                aria-selected={optionIndex === props.skillIndex}
                key={prompt.id}
              >
                <span className="file-mention-icon"><FileText size={18} /></span>
                <strong>/{prompt.trigger}</strong>
                <span>{prompt.label}</span>
                <small>Prompt</small>
                {optionIndex === 0 && <kbd>Enter</kbd>}
              </button>
            );
          })}
          {props.visibleSkillOptions.map((skill, index) => {
            const optionIndex = props.visibleCommandOptions.length + props.visiblePromptOptions.length + index;
            const disabled = skill.capabilityState !== "invocable" || skill.ambiguous;
            return (
              <button
                ref={setOptionRef(slashRefs, optionIndex)}
                className={optionIndex === props.skillIndex ? "selected" : ""}
                disabled={disabled}
                onMouseDown={(event) => {
                  event.preventDefault();
                  props.insertSkillMention(skill);
                }}
                role="option"
                aria-selected={optionIndex === props.skillIndex}
                key={skill.skillId}
              >
                <span className="file-mention-icon"><ListChecks size={18} /></span>
                <strong>{skill.displayName}</strong>
                <span>{skill.description ?? skill.statusMessage ?? "User skill"}</span>
                <small title={skill.providerKinds.map(providerLabel).join(", ")}>Skill</small>
                {!disabled && optionIndex === 0 && <kbd>Enter</kbd>}
              </button>
            );
          })}
        </div>
      )}
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
