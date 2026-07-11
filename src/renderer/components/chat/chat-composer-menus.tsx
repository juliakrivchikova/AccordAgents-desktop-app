import { useEffect, useRef, type MutableRefObject, type ReactNode } from "react";
import { FileBox, FileText, ListChecks, Minimize2, Plug } from "lucide-react";

import type {
  ArtifactSummary,
  ChatParticipant,
  ChatSavedPromptConfig,
  PluginCatalogItem,
  RepoFileSearchResult,
  UserSkillSummary
} from "../../../shared/types";
import { artifactApprovalShortLabel } from "../../../shared/artifacts";
import { chatParticipantDisplayName } from "../conversation/conversation-display";
import { providerLabel } from "./chat-conversation-data";
import {
  repoFileBasename,
  type ChatSlashSuggestion
} from "./chat-composer-draft-utils";
import { pluginSlashProviderLabels } from "./chat-plugin-options";

export function ChatComposerMenus(props: {
  artifactOptions?: ArtifactSummary[];
  fileIndex: number;
  insertArtifactMention?: (artifact: ArtifactSummary) => void;
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
  visibleFileOptions: RepoFileSearchResult[];
  visibleSlashOptions: ChatSlashSuggestion[];
}): JSX.Element {
  const mentionRefs = useActiveOptionScroll(props.mentionIndex, props.mentionOptions.length);
  // Artifacts and repository files share the "#" popover and one index space.
  const artifactOptions = props.artifactOptions ?? [];
  const hashOptionCount = artifactOptions.length + props.visibleFileOptions.length;
  const fileRefs = useActiveOptionScroll(props.fileIndex, hashOptionCount);
  const slashRefs = useActiveOptionScroll(props.skillIndex, props.visibleSlashOptions.length);
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
              <span className="file-mention-icon"><FileBox size={18} /></span>
              <strong>{artifact.name}</strong>
              <span>{`v${artifact.headVersion} · ${artifactApprovalShortLabel(artifact.approval)}`}</span>
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
                <span className="file-mention-icon"><FileText size={18} /></span>
                <strong>{repoFileBasename(file.path)}</strong>
                <span>{file.path}</span>
                {optionIndex === 0 && <kbd>Enter</kbd>}
              </button>
            );
          })}
        </div>
      )}
      {props.skillQuery !== undefined && (
        props.visibleSlashOptions.length > 0 ||
        props.skillTargetLabel
      ) && (
        <div className={slashMenuClassName} role="listbox" aria-label="Slash commands, prompts, skills, and plugins">
          <div className="chat-popover-section-title">Slash</div>
          {props.skillTargetLabel && <div className="skill-mention-menu-context">{props.skillTargetLabel}</div>}
          {props.visibleSlashOptions.map((option, index) => {
            if (option.kind === "command") {
              return <button
                ref={setOptionRef(slashRefs, index)}
                className={index === props.skillIndex ? "selected" : ""}
                onMouseDown={(event) => {
                  event.preventDefault();
                  props.insertCompactCommand();
                }}
                role="option"
                aria-selected={index === props.skillIndex}
                key={`command:${option.item.id}`}
              >
                <span className="file-mention-icon"><Minimize2 size={18} /></span>
                <strong>{option.item.label}</strong>
                <span>{option.item.description}</span>
                <small>Command</small>
                {index === 0 && <kbd>Enter</kbd>}
              </button>
            }
            if (option.kind === "prompt") {
              return <button
                ref={setOptionRef(slashRefs, index)}
                className={index === props.skillIndex ? "selected" : ""}
                onMouseDown={(event) => {
                  event.preventDefault();
                  props.insertSavedPrompt(option.item);
                }}
                role="option"
                aria-selected={index === props.skillIndex}
                key={`prompt:${option.item.id}`}
              >
                <span className="file-mention-icon"><FileText size={18} /></span>
                <strong>/{option.item.trigger}</strong>
                <span>{option.item.label}</span>
                <small>Prompt</small>
                {index === 0 && <kbd>Enter</kbd>}
              </button>
            }
            if (option.kind === "skill") {
              const disabled = option.item.capabilityState !== "invocable" || option.item.ambiguous;
              return <button
                ref={setOptionRef(slashRefs, index)}
                className={index === props.skillIndex ? "selected" : ""}
                disabled={disabled}
                onMouseDown={(event) => {
                  event.preventDefault();
                  props.insertSkillMention(option.item);
                }}
                role="option"
                aria-selected={index === props.skillIndex}
                key={`skill:${option.item.skillId}`}
              >
                <span className="file-mention-icon"><ListChecks size={18} /></span>
                <strong>{option.item.displayName}</strong>
                <span className="slash-item-copy">
                  <span>{option.item.description ?? "User skill"}</span>
                  {disabled && <span className="slash-disabled-reason">{skillDisabledReason(option.item)}</span>}
                </span>
                <ProviderChips labels={option.item.providerKinds.map(providerLabel)} />
                <small>Skill</small>
                {!disabled && index === 0 && <kbd>Enter</kbd>}
              </button>
            }
            return (
              <button
                ref={setOptionRef(slashRefs, index)}
                className={index === props.skillIndex ? "selected" : ""}
                onMouseDown={(event) => {
                  event.preventDefault();
                  props.insertPluginMention(option.item);
                }}
                role="option"
                aria-selected={index === props.skillIndex}
                key={`plugin:${option.item.id}`}
              >
                <PluginMenuIcon plugin={option.item} />
                <strong>{option.item.displayName}</strong>
                <span className="slash-item-copy">
                  <span>{option.item.description ?? option.item.statusMessage ?? "Local plugin"}</span>
                </span>
                <ProviderChips labels={pluginProviderLabels(option.item)} />
                <small>Plugin</small>
                {index === 0 && <kbd>Enter</kbd>}
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
