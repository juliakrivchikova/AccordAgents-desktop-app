import { FileText, ListChecks, Minimize2 } from "lucide-react";

import type {
  ChatParticipant,
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
  insertSkillMention: (skill: UserSkillSummary) => void;
  mentionIndex: number;
  mentionOptions: ChatParticipant[];
  participantRoleLabel: (participant: ChatParticipant) => string;
  renderParticipantAvatar: (participant: ChatParticipant) => React.ReactNode;
  skillIndex: number;
  skillQuery: string | undefined;
  skillTargetLabel?: string;
  visibleCommandOptions: SlashCommandOption[];
  visibleFileOptions: RepoFileSearchResult[];
  visibleSkillOptions: UserSkillSummary[];
}): JSX.Element {
  return (
    <>
      {props.mentionOptions.length > 0 && (
        <div className="mention-menu" role="listbox">
          <div className="chat-popover-section-title">Participants</div>
          {props.mentionOptions.map((participant, index) => (
            <button
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
        <div className="mention-menu file-mention-menu" role="listbox">
          <div className="chat-popover-section-title">Repository files</div>
          {props.visibleFileOptions.map((file, index) => (
            <button
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
      {props.skillQuery !== undefined && (props.visibleCommandOptions.length > 0 || props.visibleSkillOptions.length > 0 || props.skillTargetLabel) && (
        <div className="mention-menu skill-mention-menu" role="listbox">
          <div className="chat-popover-section-title">Skills</div>
          {props.skillTargetLabel && <div className="skill-mention-menu-context">{props.skillTargetLabel}</div>}
          {props.visibleCommandOptions.map((command, index) => (
            <button
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
          {props.visibleSkillOptions.map((skill, index) => {
            const optionIndex = props.visibleCommandOptions.length + index;
            const disabled = skill.capabilityState !== "invocable" || skill.ambiguous;
            return (
              <button
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
                <small>{skill.providerKinds.map(providerLabel).join(", ")}</small>
                {!disabled && optionIndex === 0 && <kbd>Enter</kbd>}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
