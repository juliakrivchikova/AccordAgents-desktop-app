import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction
} from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  FolderOpen,
  ImagePlus,
  Plus,
  RefreshCw,
  XCircle
} from "lucide-react";

import type {
  AgentHealth,
  AppSettings,
  ChatImageInput,
  ChatParticipant,
  ChatParticipantConfig,
  ChatProviderKind,
  GitRepoInfo
} from "../../../shared/types";
import { chatReasoningEffortLabel } from "../../../shared/reasoningEffort";
import {
  type AddableSavedParticipantConfig,
  addableSavedParticipantConfigs,
  chatAgentModeLabel,
  chatInheritedCliSettingLabel,
  selectedChatParticipantDrafts,
  validateChatStartupDrafts
} from "./chat-participant-drafts";
import { providerLabel } from "./chat-conversation-data";
import { ChatComposerAttachmentChips } from "./chat-composer-attachment-chips";
import { ChatComposerMenus } from "./chat-composer-menus";
import {
  activeMentionQuery,
  replaceActiveMention
} from "./chat-composer-draft-utils";
import {
  revokePendingImageUrls,
  useChatComposerImages
} from "./use-chat-composer-images";
import {
  CHAT_ASSISTANT_DISPLAY_NAME,
  CHAT_ASSISTANT_HANDLE,
  CHAT_ASSISTANT_ROLE_ID,
  chatParticipantDisplayName,
  chatParticipantMentionHandle,
  isChatAssistantParticipant
} from "../conversation/conversation-display";

const ACCORDAGENTS_MARK_URL = new URL("../../assets/accordagents-mark.png", import.meta.url).href;
const NEW_CHAT_ASSISTANT_PARTICIPANT_ID = "__new-chat-assistant__";
const NEW_CHAT_MENU_OFFSET = 8;
const NEW_CHAT_MENU_VIEWPORT_MARGIN = 16;

export function NewChatScreen(props: {
  prompt: string;
  repoPath: string;
  repoInfo?: GitRepoInfo;
  selectedParticipantIds: Set<string>;
  settings: AppSettings;
  agents: AgentHealth[];
  busy: boolean;
  renderParticipantAvatar: (participant: ChatParticipant) => ReactNode;
  participantRoleLabel: (participant: Pick<ChatParticipant, "roleConfigId">) => string;
  onPromptChange: (value: string) => void;
  onRepoPathChange: (value: string) => void;
  onRepoBlur: (path?: string) => void;
  onSelectRepo: () => void;
  onSelectedParticipantIdsChange: Dispatch<SetStateAction<Set<string>>>;
  onOpenParticipantsSettings: () => void;
  onStart: (imageAttachments?: ChatImageInput[]) => boolean | void | Promise<boolean | void>;
}): JSX.Element {
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingCaretRef = useRef<{ value: string; position: number } | undefined>();
  const [mentionQuery, setMentionQuery] = useState<string | undefined>();
  const [mentionIndex, setMentionIndex] = useState(0);
  const images = useChatComposerImages(undefined);
  const assistantParticipant = useMemo(
    () => newChatAssistantParticipant(props.settings, props.agents),
    [props.agents, props.settings.providers]
  );
  const savedParticipantOptions = useMemo(
    () => addableSavedParticipantConfigs(props.settings, props.agents, new Set())
      .filter(({ config }) => !isChatAssistantParticipant(config)),
    [props.agents, props.settings]
  );
  const mentionParticipants = useMemo<ChatParticipant[]>(
    () => [
      assistantParticipant,
      ...savedParticipantOptions
        .filter(({ invalidReason }) => !invalidReason)
        .map(({ config }) => config)
    ],
    [assistantParticipant, savedParticipantOptions]
  );
  const mentionOptions = mentionQuery === undefined
    ? []
    : mentionParticipants.filter((participant) => {
      const query = mentionQuery.toLowerCase();
      return participant.handle.toLowerCase().includes(query) ||
        chatParticipantDisplayName(participant).toLowerCase().includes(query);
    });
  const normalizedDrafts = selectedChatParticipantDrafts(props.settings.chatParticipantConfigs, props.selectedParticipantIds);
  const validation = validateChatStartupDrafts(normalizedDrafts, props.settings.chatRoleConfigs, props.agents, props.settings.chatBehaviorRules);
  const hasPrompt = props.prompt.trim().length > 0;
  const canStart = (hasPrompt || images.readyImages.length > 0) && !images.hasInvalidImages && !props.busy && !validation;

  useLayoutEffect(() => {
    resizeNewChatPrompt(promptRef.current);
  }, [props.prompt]);

  useLayoutEffect(() => {
    const textarea = promptRef.current;
    if (!textarea) return;
    let frameId: number | undefined;
    const scheduleResize = (): void => {
      if (frameId !== undefined) {
        window.cancelAnimationFrame(frameId);
      }
      frameId = window.requestAnimationFrame(() => {
        frameId = undefined;
        resizeNewChatPrompt(textarea);
      });
    };
    const resizeObserver = new ResizeObserver(scheduleResize);
    resizeObserver.observe(textarea);
    window.addEventListener("resize", scheduleResize);
    return () => {
      if (frameId !== undefined) {
        window.cancelAnimationFrame(frameId);
      }
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleResize);
    };
  }, []);

  useEffect(() => {
    const pendingCaret = pendingCaretRef.current;
    if (!pendingCaret || pendingCaret.value !== props.prompt) {
      return;
    }
    const textarea = promptRef.current;
    if (!textarea) {
      return;
    }
    const position = Math.min(pendingCaret.position, textarea.value.length);
    textarea.focus();
    textarea.setSelectionRange(position, position);
    pendingCaretRef.current = undefined;
  }, [props.prompt]);

  function updatePrompt(value: string): void {
    props.onPromptChange(value);
    setMentionQuery(activeMentionQuery(value));
    setMentionIndex(0);
  }

  function insertMention(participant: ChatParticipant): void {
    const nextPrompt = replaceActiveMention(props.prompt, chatParticipantMentionHandle(participant, mentionParticipants));
    pendingCaretRef.current = { value: nextPrompt, position: nextPrompt.length };
    props.onPromptChange(nextPrompt);
    if (!isNewChatAssistantOption(participant)) {
      props.onSelectedParticipantIdsChange((current) => new Set(current).add(participant.id));
    }
    setMentionQuery(undefined);
    setMentionIndex(0);
  }

  async function startChat(): Promise<void> {
    if (!canStart) return;
    const pendingImagesToSend = images.pendingImages;
    const imageInputs = images.readyImages.map((image): ChatImageInput => ({
      filename: image.filename,
      mimeType: image.mimeType,
      dataBase64: image.dataBase64 ?? ""
    }));
    images.setPendingImages([]);
    const started = await props.onStart(imageInputs);
    if (started === false) {
      images.setPendingImages(pendingImagesToSend);
      return;
    }
    revokePendingImageUrls(pendingImagesToSend);
  }

  return (
    <div className="new-chat-screen" data-testid="new-chat-screen">
      <div className="new-chat-hero">
        <div className="new-chat-logo" aria-hidden="true">
          <span className="new-chat-logo-glow" />
          <span className="new-chat-logo-ring" />
          <img src={ACCORDAGENTS_MARK_URL} alt="" draggable="false" />
        </div>
        <h1>Start a new chat</h1>
        <p>Coordinate AI agents in one workspace</p>
      </div>

      <div className="new-chat-card">
        <ChatComposerAttachmentChips
          pendingImages={images.pendingImages}
          removeFileMention={() => undefined}
          removePendingImage={images.removePendingImage}
          removeSkillMention={() => undefined}
          selectedFileMentions={[]}
          selectedSkillMentions={[]}
        />
        <div className="new-chat-input-wrap">
          <ChatComposerMenus
            fileIndex={0}
            insertCompactCommand={() => undefined}
            insertFileMention={() => undefined}
            insertMention={insertMention}
            insertSkillMention={() => undefined}
            mentionIndex={mentionIndex}
            mentionOptions={mentionOptions}
            participantRoleLabel={props.participantRoleLabel}
            renderParticipantAvatar={props.renderParticipantAvatar}
            skillIndex={0}
            skillQuery={undefined}
            visibleCommandOptions={[]}
            visibleFileOptions={[]}
            visibleSkillOptions={[]}
          />
          <textarea
            ref={promptRef}
            className="new-chat-prompt"
            value={props.prompt}
            placeholder="What are you working on?"
            rows={3}
            data-testid="new-chat-prompt"
            onChange={(event) => updatePrompt(event.target.value)}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData?.files ?? []);
              if (files.some((file) => file.type.startsWith("image/"))) {
                event.preventDefault();
                void images.addImageFiles(files);
              }
            }}
            onDrop={(event) => {
              const files = Array.from(event.dataTransfer?.files ?? []);
              if (files.some((file) => file.type.startsWith("image/"))) {
                event.preventDefault();
                void images.addImageFiles(files);
              }
            }}
            onDragOver={(event) => {
              if (Array.from(event.dataTransfer.types).includes("Files")) {
                event.preventDefault();
              }
            }}
            onKeyDown={(event) => {
              if (mentionOptions.length > 0 && event.key === "ArrowDown") {
                event.preventDefault();
                setMentionIndex((current) => (current + 1) % mentionOptions.length);
                return;
              }
              if (mentionOptions.length > 0 && event.key === "ArrowUp") {
                event.preventDefault();
                setMentionIndex((current) => (current - 1 + mentionOptions.length) % mentionOptions.length);
                return;
              }
              if (mentionOptions.length > 0 && (event.key === "Enter" || event.key === "Tab")) {
                event.preventDefault();
                insertMention(mentionOptions[mentionIndex] ?? mentionOptions[0]);
                return;
              }
              if (event.key === "Escape") {
                setMentionQuery(undefined);
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void startChat();
              }
            }}
            onBlur={() => window.setTimeout(() => setMentionQuery(undefined), 120)}
          />
        </div>
        <div className="new-chat-toolbar">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            hidden
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              void images.addImageFiles(files);
            }}
          />
          <button
            type="button"
            className="new-chat-icon-button"
            title="Attach image"
            aria-label="Attach image"
            onClick={() => fileInputRef.current?.click()}
          >
            <ImagePlus size={18} aria-hidden />
          </button>
          <FolderPicker
            repoPath={props.repoPath}
            settings={props.settings}
            onRepoPathChange={props.onRepoPathChange}
            onRepoBlur={props.onRepoBlur}
            onSelectRepo={props.onSelectRepo}
          />
          <span className="new-chat-toolbar-spacer" />
          <ParticipantPicker
            assistantParticipant={assistantParticipant}
            savedParticipantOptions={savedParticipantOptions}
            selectedParticipantIds={props.selectedParticipantIds}
            renderParticipantAvatar={props.renderParticipantAvatar}
            participantRoleLabel={props.participantRoleLabel}
            onSelectedParticipantIdsChange={props.onSelectedParticipantIdsChange}
            onOpenParticipantsSettings={props.onOpenParticipantsSettings}
          />
          <button
            type="button"
            className="new-chat-send"
            disabled={!canStart}
            title="Start chat"
            aria-label="Start chat"
            data-testid="new-chat-start"
            onClick={() => void startChat()}
          >
            {props.busy ? <RefreshCw className="spin" size={18} aria-hidden /> : <ArrowUp size={18} strokeWidth={2.25} aria-hidden />}
          </button>
        </div>
      </div>

      {props.repoInfo && !props.repoInfo.isRepo && (
        <div className="repo-status new-chat-repo-status bad">
          <XCircle size={16} aria-hidden />
          {props.repoInfo.error || "Not a git repository"}
        </div>
      )}

      {validation && <div className="inline-error new-chat-error">{validation}</div>}
    </div>
  );
}

function resizeNewChatPrompt(textarea: HTMLTextAreaElement | null): void {
  if (!textarea) return;
  const style = window.getComputedStyle(textarea);
  const minHeight = Number.parseFloat(style.minHeight) || 94;
  const maxHeight = Number.parseFloat(style.maxHeight) || 220;
  textarea.style.height = "auto";
  const nextHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight);
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
}

function FolderPicker(props: {
  repoPath: string;
  settings: AppSettings;
  onRepoPathChange: (value: string) => void;
  onRepoBlur: (path?: string) => void;
  onSelectRepo: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useCloseOnOutside<HTMLDivElement>(open, () => setOpen(false));
  const repoPath = props.repoPath.trim();
  const recentRepoPath = props.settings.lastRepoPath?.trim();
  const recentOptions = useMemo(() => {
    if (!recentRepoPath || recentRepoPath === repoPath) return [];
    return [recentRepoPath];
  }, [recentRepoPath, repoPath]);
  const label = repoPath ? folderName(repoPath) : "Choose a folder";

  function selectPath(path: string): void {
    props.onRepoPathChange(path);
    props.onRepoBlur(path);
    setOpen(false);
  }

  return (
    <div className="new-chat-folder-picker" ref={rootRef}>
      <button
        type="button"
        className={`new-chat-chip ${repoPath ? "is-set" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={repoPath || "Choose a folder"}
        onClick={() => setOpen((current) => !current)}
      >
        <FolderOpen size={15} aria-hidden />
        <span>{label}</span>
        <ChevronDown size={14} aria-hidden />
      </button>
      {open && (
        <div className="new-chat-menu new-chat-folder-menu" role="menu">
          {recentOptions.length > 0 && (
            <>
              <div className="new-chat-menu-section">Recent folders</div>
              {recentOptions.map((path) => (
                <button key={path} type="button" className="new-chat-menu-item" role="menuitem" onClick={() => selectPath(path)}>
                  <FolderOpen size={15} aria-hidden />
                  <span>{folderName(path)}</span>
                  {repoPath === path && <Check size={14} className="new-chat-menu-check" aria-hidden />}
                </button>
              ))}
              <div className="new-chat-menu-divider" />
            </>
          )}
          <button
            type="button"
            className="new-chat-menu-item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              props.onSelectRepo();
            }}
          >
            <Plus size={15} aria-hidden />
            <span>Browse for a folder...</span>
          </button>
          <button
            type="button"
            className="new-chat-menu-item"
            role="menuitem"
            onClick={() => {
              props.onRepoPathChange("");
              setOpen(false);
            }}
          >
            <XCircle size={15} aria-hidden />
            <span>Work without a folder</span>
            {!repoPath && <Check size={14} className="new-chat-menu-check" aria-hidden />}
          </button>
        </div>
      )}
    </div>
  );
}

function ParticipantPicker(props: {
  assistantParticipant: ChatParticipantConfig;
  savedParticipantOptions: AddableSavedParticipantConfig[];
  selectedParticipantIds: Set<string>;
  renderParticipantAvatar: (participant: ChatParticipant) => ReactNode;
  participantRoleLabel: (participant: Pick<ChatParticipant, "roleConfigId">) => string;
  onSelectedParticipantIdsChange: Dispatch<SetStateAction<Set<string>>>;
  onOpenParticipantsSettings: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [expandedParticipantIds, setExpandedParticipantIds] = useState<Set<string>>(() => new Set());
  const rootRef = useCloseOnOutside<HTMLDivElement>(open, () => setOpen(false));
  const participantMenuMaxHeight = useNewChatMenuMaxHeight(rootRef, open);
  const participantOptions: Array<AddableSavedParticipantConfig & { locked?: boolean }> = [
    { config: props.assistantParticipant, locked: true },
    ...props.savedParticipantOptions
  ];
  const selectedOptions = participantOptions.filter(({ config, locked }) => locked || props.selectedParticipantIds.has(config.id));
  const selectedCount = selectedOptions.length;
  const label = selectedCount > 0 ? `${selectedCount} participant${selectedCount === 1 ? "" : "s"}` : "Add participants";

  function toggleParticipant(id: string): void {
    props.onSelectedParticipantIdsChange((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function toggleExpanded(id: string): void {
    setExpandedParticipantIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  return (
    <div className="new-chat-participant-picker" ref={rootRef}>
      <button
        type="button"
        className="new-chat-chip new-chat-participant-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="new-chat-avatar-stack" aria-hidden="true">
          {selectedOptions.slice(0, 4).map(({ config }, index) => (
            <span key={config.id} className="new-chat-avatar-stack-item" style={{ marginLeft: index === 0 ? 0 : -9, zIndex: index + 1 }}>
              {props.renderParticipantAvatar(config)}
            </span>
          ))}
        </span>
        <span>{label}</span>
        <ChevronDown size={14} aria-hidden />
      </button>
      {open && (
        <div
          className="new-chat-menu new-chat-participant-menu"
          role="menu"
          style={participantMenuMaxHeight === undefined ? undefined : { maxHeight: participantMenuMaxHeight }}
        >
          {participantOptions.map(({ config: participant, invalidReason, locked }) => {
            const selected = Boolean(locked) || props.selectedParticipantIds.has(participant.id);
            const expanded = expandedParticipantIds.has(participant.id);
            const detailValues = participantDetailValues(participant);
            const displayName = chatParticipantDisplayName(participant);
            return (
              <div
                key={participant.id}
                className={`new-chat-participant-row ${selected ? "is-selected" : ""} ${expanded ? "is-expanded" : ""} ${invalidReason ? "is-disabled" : ""}`}
                role="none"
                title={invalidReason}
              >
                <button
                  type="button"
                  className="new-chat-participant-main"
                  role="menuitem"
                  aria-expanded={expanded}
                  onClick={() => toggleExpanded(participant.id)}
                >
                  {props.renderParticipantAvatar(participant)}
                  <span className="new-chat-participant-text">
                    <span className="new-chat-participant-title">
                      <strong>{displayName}</strong>
                      <span>- {providerLabel(participant.kind)}</span>
                    </span>
                    <small>{props.participantRoleLabel(participant)}</small>
                  </span>
                  <ChevronDown className="new-chat-participant-disclosure" size={14} aria-hidden />
                </button>
                <button
                  type="button"
                  className={`new-chat-participant-check ${selected ? "is-on" : ""}`}
                  role="menuitemcheckbox"
                  aria-checked={selected}
                  aria-label={locked ? `${CHAT_ASSISTANT_DISPLAY_NAME} is always included` : `${selected ? "Remove" : "Add"} @${participant.handle}`}
                  disabled={Boolean(locked) || Boolean(invalidReason)}
                  onClick={() => {
                    if (!locked) {
                      toggleParticipant(participant.id);
                    }
                  }}
                >
                  {selected && <Check size={14} strokeWidth={3.2} />}
                </button>
                {expanded && (
                  <div className="new-chat-participant-details">
                    {detailValues.map((value, index) => (
                      <span key={`${index}-${value}`} className="new-chat-participant-detail">{value}</span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          <div className="new-chat-menu-divider" />
          <div className="new-chat-participant-footer">
            <button
              type="button"
              className="new-chat-manage-link"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                props.onOpenParticipantsSettings();
              }}
            >
              Manage in settings
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function newChatAssistantParticipant(settings: AppSettings, agents: AgentHealth[]): ChatParticipantConfig {
  return {
    id: NEW_CHAT_ASSISTANT_PARTICIPANT_ID,
    handle: CHAT_ASSISTANT_HANDLE,
    roleConfigId: CHAT_ASSISTANT_ROLE_ID,
    behaviorRuleIds: [],
    kind: preferredAssistantProviderKind(settings, agents),
    agentMode: "default",
    permissions: {
      repoRead: false,
      workspaceWrite: false,
      webAccess: false,
      shell: {
        enabled: false,
        rules: []
      }
    },
    updatedAt: ""
  };
}

function isNewChatAssistantOption(participant: Pick<ChatParticipantConfig, "id" | "handle" | "roleConfigId">): boolean {
  return participant.id === NEW_CHAT_ASSISTANT_PARTICIPANT_ID || isChatAssistantParticipant(participant);
}

function preferredAssistantProviderKind(settings: AppSettings, agents: AgentHealth[]): ChatProviderKind {
  const codexInstalled = agents.some((agent) => agent.kind === "codex-cli" && agent.installed);
  const claudeInstalled = agents.some((agent) => agent.kind === "claude-code" && agent.installed);
  const codexEnabled = settings.providers.some((provider) => provider.kind === "codex-cli" && provider.enabled);
  const claudeEnabled = settings.providers.some((provider) => provider.kind === "claude-code" && provider.enabled);
  if (codexInstalled && codexEnabled) return "codex-cli";
  if (claudeInstalled && claudeEnabled) return "claude-code";
  if (codexInstalled) return "codex-cli";
  if (claudeInstalled) return "claude-code";
  if (codexEnabled) return "codex-cli";
  if (claudeEnabled) return "claude-code";
  return "codex-cli";
}

function participantDetailValues(participant: ChatParticipantConfig): string[] {
  const inheritedSetting = chatInheritedCliSettingLabel(participant.kind);
  return [
    chatAgentModeLabel(participant.agentMode),
    participant.model?.trim() || inheritedSetting,
    participant.reasoningEffort ? chatReasoningEffortLabel(participant.reasoningEffort) : inheritedSetting
  ];
}

function useCloseOnOutside<T extends HTMLElement>(open: boolean, onClose: () => void): RefObject<T> {
  const ref = useRef<T>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [onClose, open]);

  return ref;
}

function useNewChatMenuMaxHeight<T extends HTMLElement>(rootRef: RefObject<T>, open: boolean): number | undefined {
  const [maxHeight, setMaxHeight] = useState<number | undefined>();

  useLayoutEffect(() => {
    if (!open) {
      setMaxHeight(undefined);
      return;
    }

    function updateMaxHeight(): void {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const topbarBottom = document.querySelector<HTMLElement>("[data-shell='topbar']")?.getBoundingClientRect().bottom ?? 0;
      const safeTop = Math.max(NEW_CHAT_MENU_VIEWPORT_MARGIN, topbarBottom + NEW_CHAT_MENU_VIEWPORT_MARGIN);
      setMaxHeight(Math.max(0, Math.floor(rect.top - NEW_CHAT_MENU_OFFSET - safeTop)));
    }

    updateMaxHeight();
    window.addEventListener("resize", updateMaxHeight);
    window.addEventListener("scroll", updateMaxHeight, true);
    return () => {
      window.removeEventListener("resize", updateMaxHeight);
      window.removeEventListener("scroll", updateMaxHeight, true);
    };
  }, [open, rootRef]);

  return maxHeight;
}

function folderName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}
