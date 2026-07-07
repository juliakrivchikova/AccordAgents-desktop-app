import { useEffect, useRef, type MutableRefObject, type ReactNode } from "react";
import { FileText, ListChecks, Minimize2, Plug } from "lucide-react";

import type {
  ChatParticipant,
  ChatSavedPromptConfig,
  PluginCatalogItem,
  RepoFileSearchResult,
  UserSkillSummary
} from "../../../shared/types";
import { chatParticipantDisplayName } from "../conversation/conversation-display";
import { providerLabel } from "./chat-conversation-data";
import {
  repoFileBasename,
  type SlashCommandOption
} from "./chat-composer-draft-utils";
import { pluginSlashProviderLabels } from "./chat-plugin-options";

export function ChatComposerMenus(props: {
  fileIndex: number;
  insertCompactCommand: () => void;
  insertFileMention: (file: RepoFileSearchResult) => void;
  insertMention: (participant: ChatParticipant) => void;
  insertSavedPrompt: (prompt: ChatSavedPromptConfig) => void;
  insertSkillMention: (skill: UserSkillSummary) => void;
  insertPluginMention: (plugin: PluginCatalogItem) => void;
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
  visiblePluginOptions: PluginCatalogItem[];
}): JSX.Element {
  const mentionRefs = useActiveOptionScroll(props.mentionIndex, props.mentionOptions.length);
  const fileRefs = useActiveOptionScroll(props.fileIndex, props.visibleFileOptions.length);
  const slashOptionCount = props.visibleCommandOptions.length +
    props.visiblePromptOptions.length +
    props.visibleSkillOptions.length +
    props.visiblePluginOptions.length;
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
        props.visiblePluginOptions.length > 0 ||
        props.skillTargetLabel
      ) && (
        <div className={slashMenuClassName} role="listbox" aria-label="Slash commands, prompts, skills, and plugins">
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
                <span className="slash-item-copy">
                  <span>{skill.description ?? "User skill"}</span>
                  {disabled && <span className="slash-disabled-reason">{skillDisabledReason(skill)}</span>}
                </span>
                <ProviderChips labels={skill.providerKinds.map(providerLabel)} />
                <small>Skill</small>
                {!disabled && optionIndex === 0 && <kbd>Enter</kbd>}
              </button>
            );
          })}
          {props.visiblePluginOptions.map((plugin, index) => {
            const optionIndex = props.visibleCommandOptions.length +
              props.visiblePromptOptions.length +
              props.visibleSkillOptions.length +
              index;
            return (
              <button
                ref={setOptionRef(slashRefs, optionIndex)}
                className={optionIndex === props.skillIndex ? "selected" : ""}
                onMouseDown={(event) => {
                  event.preventDefault();
                  props.insertPluginMention(plugin);
                }}
                role="option"
                aria-selected={optionIndex === props.skillIndex}
                key={plugin.id}
              >
                <PluginMenuIcon plugin={plugin} />
                <strong>{plugin.displayName}</strong>
                <span className="slash-item-copy">
                  <span>{plugin.description ?? plugin.statusMessage ?? "Local plugin"}</span>
                </span>
                <ProviderChips labels={pluginProviderLabels(plugin)} />
                <small>Plugin</small>
                {optionIndex === 0 && <kbd>Enter</kbd>}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

function PluginMenuIcon(props: { plugin: PluginCatalogItem }): JSX.Element {
  if (props.plugin.iconUrl) {
    return (
      <span className="file-mention-icon has-image">
        <img src={props.plugin.iconUrl} alt="" aria-hidden="true" />
      </span>
    );
  }
  return <span className="file-mention-icon"><Plug size={18} /></span>;
}

function ProviderChips(props: { labels: string[] }): JSX.Element {
  const labels = props.labels.length > 0 ? props.labels : ["None"];
  return (
    <span className="slash-provider-chips" title={labels.join(", ")}>
      {labels.map((label) => <span key={label}>{label}</span>)}
    </span>
  );
}

function pluginProviderLabels(plugin: PluginCatalogItem): string[] {
  return pluginSlashProviderLabels(plugin, providerLabel);
}

function skillDisabledReason(skill: UserSkillSummary): string {
  if (skill.statusMessage) {
    return skill.statusMessage;
  }
  if (skill.ambiguous) {
    return "Duplicate skill variants are ambiguous.";
  }
  return "This skill is not selectable for the current target.";
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
