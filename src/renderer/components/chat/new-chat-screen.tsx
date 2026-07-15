import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
  type UIEvent
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
  ConversationSummary,
  CloudRunRemoteExecutionMode,
  ChatProviderKind,
  ChatSkillMention,
  GitRepoInfo,
  RepoFileMention
} from "../../../shared/types";
import { chatReasoningEffortLabel } from "../../../shared/reasoningEffort";
import {
  type AddableSavedParticipantConfig,
  CHAT_RUN_LOCATION_OPTIONS,
  addableSavedParticipantConfigs,
  chatAgentModeLabel,
  chatInheritedCliSettingLabel,
  chatRunLocationLabel,
  normalizeChatRunLocation,
  selectedOrMentionedChatParticipantDrafts,
  validateChatStartupDrafts
} from "./chat-participant-drafts";
import { providerLabel } from "./chat-conversation-data";
import {
  CLI_PROVIDER_DISPLAY_ORDER,
  cliProviderMetadata,
  readyProviderKinds,
  resolveAssistantProviderKind
} from "../../../shared/cliReadiness";
import { CliReadinessSetupPanel } from "./cli-readiness-setup-panel";
import { ChatComposerAttachmentChips } from "./chat-composer-attachment-chips";
import { ChatComposerMenus } from "./chat-composer-menus";
import {
  type DraftPluginMention,
  draftStartsWithPluginMention
} from "./chat-composer-draft-utils";
import { renderSlashHighlightedDraft } from "./chat-composer-draft-highlights";
import { useChatComposerImages } from "./use-chat-composer-images";
import { useChatComposerMentions } from "./use-chat-composer-mentions";
import { sortSavedParticipantOptionsByUsage } from "./new-chat-participant-usage";
import {
  CHAT_ASSISTANT_DISPLAY_NAME,
  CHAT_ASSISTANT_HANDLE,
  CHAT_ASSISTANT_ROLE_ID,
  chatParticipantDisplayName,
  isChatAssistantParticipant
} from "../conversation/conversation-display";

const ACCORDAGENTS_MARK_URL = new URL("../../assets/accordagents-mark.png", import.meta.url).href;
const NEW_CHAT_ASSISTANT_PARTICIPANT_ID = "__new-chat-assistant__";
const NEW_CHAT_MENU_OFFSET = 8;
const NEW_CHAT_MENU_VIEWPORT_MARGIN = 16;

export function NewChatScreen(props: {
  prompt: string;
  initialPluginMentions?: DraftPluginMention[];
  initialSkillMentions?: ChatSkillMention[];
  pendingImages: ReturnType<typeof useChatComposerImages>["pendingImages"];
  selectedFileMentions: RepoFileMention[];
  selectedPluginMentions: DraftPluginMention[];
  selectedSkillMentions: ChatSkillMention[];
  prefillPrompt?: string;
  prefillRequestKey?: number;
  repoPath: string;
  repoInfo?: GitRepoInfo;
  selectedParticipantIds: Set<string>;
  selectedParticipantRunLocations: Record<string, CloudRunRemoteExecutionMode>;
  settings: AppSettings;
  summaries: ConversationSummary[];
  agents: AgentHealth[];
  busy: boolean;
  selectedAssistantProviderKind?: ChatProviderKind;
  renderParticipantAvatar: (participant: ChatParticipant) => ReactNode;
  participantRoleLabel: (participant: Pick<ChatParticipant, "roleConfigId">) => string;
  onPromptChange: (value: string) => void;
  onPendingImagesChange: ReturnType<typeof useChatComposerImages>["setPendingImages"];
  onSelectedFileMentionsChange: Dispatch<SetStateAction<RepoFileMention[]>>;
  onSelectedPluginMentionsChange: Dispatch<SetStateAction<DraftPluginMention[]>>;
  onSelectedSkillMentionsChange: Dispatch<SetStateAction<ChatSkillMention[]>>;
  onRepoPathChange: (value: string) => void;
  onRepoBlur: (path?: string) => void;
  onSelectRepo: () => void;
  onSelectedParticipantIdsChange: Dispatch<SetStateAction<Set<string>>>;
  onSelectedParticipantRunLocationsChange: Dispatch<SetStateAction<Record<string, CloudRunRemoteExecutionMode>>>;
  onOpenParticipantsSettings: () => void;
  onOpenProviderSettings: () => void;
  onSelectedAssistantProviderKindChange: (kind: ChatProviderKind) => void | Promise<void>;
  onSetupCompletedProviderKindChange: (kind: ChatProviderKind | undefined) => void;
  onRefreshAgents: () => Promise<AgentHealth[]>;
  onStart: (repoFileMentions?: RepoFileMention[], imageAttachments?: ChatImageInput[], skillMentions?: ChatSkillMention[]) => boolean | void | Promise<boolean | void>;
}): JSX.Element {
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const handledPrefillCaretKeyRef = useRef<number | undefined>();
  const images = useChatComposerImages(undefined, {
    pendingImages: props.pendingImages,
    setPendingImages: props.onPendingImagesChange
  });
  const readyKinds = useMemo(
    () => readyProviderKinds(props.agents, props.settings.providers),
    [props.agents, props.settings.providers]
  );
  const configuredAssistantProviderKind = props.selectedAssistantProviderKind ?? props.settings.assistantProviderKind;
  const assistantProviderKind = useMemo(
    () => resolveAssistantProviderKind({
      agents: props.agents,
      providers: props.settings.providers,
      explicitKind: configuredAssistantProviderKind,
      lastSuccessfulKind: props.settings.lastSuccessfulChatProviderKind
    }),
    [configuredAssistantProviderKind, props.agents, props.settings.lastSuccessfulChatProviderKind, props.settings.providers]
  );
  const assistantParticipant = useMemo(
    () => assistantProviderKind ? newChatAssistantParticipant(assistantProviderKind) : undefined,
    [assistantProviderKind]
  );
  const savedParticipantOptions = useMemo(
    () => sortSavedParticipantOptionsByUsage(
      addableSavedParticipantConfigs(props.settings, props.agents, new Set())
        .filter(({ config }) => !isChatAssistantParticipant(config)),
      props.summaries
    ),
    [props.agents, props.settings, props.summaries]
  );
  const mentionParticipants = useMemo<ChatParticipant[]>(
    () => [
      ...(assistantParticipant ? [assistantParticipant] : []),
      ...savedParticipantOptions
        .filter(({ invalidReason }) => !invalidReason)
        .map(({ config }) => config)
    ],
    [assistantParticipant, savedParticipantOptions]
  );
  const prospectiveParticipantDrafts = useMemo(
    () => selectedOrMentionedChatParticipantDrafts(
      props.settings.chatParticipantConfigs,
      props.selectedParticipantIds,
      props.prompt,
      props.selectedParticipantRunLocations
    ),
    [props.prompt, props.selectedParticipantIds, props.selectedParticipantRunLocations, props.settings.chatParticipantConfigs]
  );
  const searchSource = useMemo(
    () => ({
      type: "pre-chat" as const,
      repoPath: props.repoPath.trim() || undefined,
      participants: prospectiveParticipantDrafts,
      assistantProviderKind
    }),
    [assistantProviderKind, props.repoPath, prospectiveParticipantDrafts]
  );
  const mentions = useChatComposerMentions({
    draft: props.prompt,
    initialPluginMentions: props.initialPluginMentions,
    initialSkillMentions: props.initialSkillMentions,
    mentionSeedKey: props.prefillRequestKey,
    searchSource,
    onDraftChange: props.onPromptChange,
    participants: mentionParticipants,
    savedPrompts: props.settings.chatSavedPrompts,
    selectedFileMentions: props.selectedFileMentions,
    selectedPluginMentions: props.selectedPluginMentions,
    selectedSkillMentions: props.selectedSkillMentions,
    onSelectedFileMentionsChange: props.onSelectedFileMentionsChange,
    onSelectedPluginMentionsChange: props.onSelectedPluginMentionsChange,
    onSelectedSkillMentionsChange: props.onSelectedSkillMentionsChange,
    onMentionInserted: (participant) => {
      if (!isNewChatAssistantOption(participant)) {
        props.onSelectedParticipantIdsChange((current) => new Set(current).add(participant.id));
      }
    }
  });
  const validation = validateChatStartupDrafts(
    prospectiveParticipantDrafts,
    props.settings.chatRoleConfigs,
    props.agents,
    props.settings.chatBehaviorRules,
    props.settings.providers
  );
  const hasPrompt = props.prompt.trim().length > 0;
  const canSubmit = (hasPrompt || images.readyImages.length > 0 || mentions.selectedSkillMentions.length > 0) && !images.hasInvalidImages && !props.busy && !validation;
  const hasLeadingPluginToken = draftStartsWithPluginMention(props.prompt, mentions.selectedPluginMentions);

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
    const pendingCaret = mentions.pendingCaretRef.current;
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
    mentions.pendingCaretRef.current = undefined;
  }, [mentions.pendingCaretRef, props.prompt]);

  useLayoutEffect(() => {
    if (
      props.prefillRequestKey === undefined ||
      props.prefillPrompt === undefined ||
      props.prompt !== props.prefillPrompt ||
      handledPrefillCaretKeyRef.current === props.prefillRequestKey
    ) {
      return;
    }
    const textarea = promptRef.current;
    if (!textarea) {
      return;
    }
    const placeCaretAtEnd = (): void => {
      const position = textarea.value.length;
      textarea.focus();
      textarea.setSelectionRange(position, position);
      textarea.scrollTop = textarea.scrollHeight;
      textarea.scrollLeft = textarea.scrollWidth;
    };
    placeCaretAtEnd();
    const frameId = window.requestAnimationFrame(placeCaretAtEnd);
    handledPrefillCaretKeyRef.current = props.prefillRequestKey;
    return () => window.cancelAnimationFrame(frameId);
  }, [props.prefillPrompt, props.prefillRequestKey, props.prompt]);

  function syncHighlightScroll(event: UIEvent<HTMLTextAreaElement>): void {
    if (!highlightRef.current) {
      return;
    }
    highlightRef.current.scrollTop = event.currentTarget.scrollTop;
    highlightRef.current.scrollLeft = event.currentTarget.scrollLeft;
  }

  async function startChat(): Promise<void> {
    if (!canSubmit) return;
    const fileMentionsToSend = mentions.selectedFileMentions;
    const skillMentionsToSend = mentions.selectedSkillMentions;
    const imageInputs = images.readyImages.map((image): ChatImageInput => ({
      filename: image.filename,
      mimeType: image.mimeType,
      dataBase64: image.dataBase64 ?? ""
    }));
    const started = await props.onStart(fileMentionsToSend, imageInputs, skillMentionsToSend);
    if (started === false) return;
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

      {readyKinds.length === 0 && (
        <CliReadinessSetupPanel
          agents={props.agents}
          settings={props.settings}
          checking={props.agents.some((agent) => agent.checking)}
          onRefresh={props.onRefreshAgents}
          onOpenSettings={props.onOpenProviderSettings}
          onProviderReady={(kind) => {
            props.onSetupCompletedProviderKindChange(kind);
            void props.onSelectedAssistantProviderKindChange(kind);
          }}
        />
      )}

      {readyKinds.length > 0 && !assistantProviderKind && (
        <div className="new-chat-provider-choice" data-testid="new-chat-provider-choice">
          <strong>Choose the Assistant provider</strong>
          <span>{configuredAssistantProviderKind
            ? "The selected provider is no longer ready. Choose another ready provider."
            : "All ready providers are available equally."}</span>
          <div>
            {CLI_PROVIDER_DISPLAY_ORDER.filter((kind) => readyKinds.includes(kind)).map((kind) => (
              <button type="button" key={kind} onClick={() => void props.onSelectedAssistantProviderKindChange(kind)}>
                {cliProviderMetadata(kind).label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="new-chat-card" hidden={readyKinds.length === 0}>
        <ChatComposerAttachmentChips
          pendingImages={images.pendingImages}
          removeFileMention={mentions.removeFileMention}
          removePendingImage={images.removePendingImage}
          removeSkillMention={mentions.removeSkillMention}
          selectedFileMentions={mentions.selectedFileMentions}
          selectedSkillMentions={mentions.selectedSkillMentions}
        />
        <div className={["new-chat-input-wrap", mentions.showSkillHighlights ? "has-skill-highlights" : ""].filter(Boolean).join(" ")}>
          <ChatComposerMenus
            fileIndex={mentions.fileIndex}
            insertCompactCommand={mentions.insertCompactCommand}
            insertFileMention={mentions.insertFileMention}
            insertMention={mentions.insertMention}
            insertSavedPrompt={mentions.insertSavedPrompt}
            insertSkillMention={mentions.insertSkillMention}
            insertPluginMention={mentions.insertPluginMention}
            mentionIndex={mentions.mentionIndex}
            mentionOptions={mentions.mentionOptions}
            participantRoleLabel={props.participantRoleLabel}
            renderParticipantAvatar={props.renderParticipantAvatar}
            slashMenuPlacement="below"
            skillIndex={mentions.skillIndex}
            skillQuery={mentions.skillQuery}
            skillTargetLabel={mentions.skillTargetLabel}
            visibleFileOptions={mentions.visibleFileOptions}
            visibleSlashOptions={mentions.visibleSlashOptions}
          />
          <textarea
            ref={promptRef}
            className={[
              "new-chat-prompt",
              mentions.showSkillHighlights ? "skill-highlight-textarea" : "",
              hasLeadingPluginToken ? "has-leading-plugin-token" : ""
            ].filter(Boolean).join(" ")}
            value={props.prompt}
            placeholder="What are you working on?"
            rows={3}
            data-testid="new-chat-prompt"
            spellCheck={!mentions.showSkillHighlights}
            onChange={(event) => mentions.updateDraft(event.target.value)}
            onScroll={syncHighlightScroll}
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
              if (mentions.visibleFileOptions.length > 0 && event.key === "ArrowDown") {
                event.preventDefault();
                mentions.setFileIndex((current) => (current + 1) % mentions.visibleFileOptions.length);
                return;
              }
              if (mentions.visibleFileOptions.length > 0 && event.key === "ArrowUp") {
                event.preventDefault();
                mentions.setFileIndex((current) => (current - 1 + mentions.visibleFileOptions.length) % mentions.visibleFileOptions.length);
                return;
              }
              if (mentions.visibleFileOptions.length > 0 && (event.key === "Enter" || event.key === "Tab")) {
                event.preventDefault();
                mentions.insertFileMention(mentions.visibleFileOptions[mentions.fileIndex] ?? mentions.visibleFileOptions[0]);
                return;
              }
              if (mentions.visibleSlashOptionCount > 0 && event.key === "ArrowDown") {
                event.preventDefault();
                mentions.setSkillIndex((current) => (current + 1) % mentions.visibleSlashOptionCount);
                return;
              }
              if (mentions.visibleSlashOptionCount > 0 && event.key === "ArrowUp") {
                event.preventDefault();
                mentions.setSkillIndex((current) => (current - 1 + mentions.visibleSlashOptionCount) % mentions.visibleSlashOptionCount);
                return;
              }
              if (mentions.visibleSlashOptionCount > 0 && (event.key === "Enter" || event.key === "Tab")) {
                event.preventDefault();
                mentions.insertSlashOptionAtIndex(mentions.skillIndex);
                return;
              }
              if (mentions.mentionOptions.length > 0 && event.key === "ArrowDown") {
                event.preventDefault();
                mentions.setMentionIndex((current) => (current + 1) % mentions.mentionOptions.length);
                return;
              }
              if (mentions.mentionOptions.length > 0 && event.key === "ArrowUp") {
                event.preventDefault();
                mentions.setMentionIndex((current) => (current - 1 + mentions.mentionOptions.length) % mentions.mentionOptions.length);
                return;
              }
              if (mentions.mentionOptions.length > 0 && (event.key === "Enter" || event.key === "Tab")) {
                event.preventDefault();
                mentions.insertMention(mentions.mentionOptions[mentions.mentionIndex] ?? mentions.mentionOptions[0]);
                return;
              }
              if (event.key === "Escape") {
                mentions.setMentionQuery(undefined);
                mentions.setFileQuery(undefined);
                mentions.setSkillQuery(undefined);
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void startChat();
              }
            }}
            onBlur={() => window.setTimeout(() => {
              mentions.setMentionQuery(undefined);
              mentions.setFileQuery(undefined);
              mentions.setSkillQuery(undefined);
            }, 120)}
          />
          {mentions.showSkillHighlights && (
            <div ref={highlightRef} className="chat-draft-highlight" aria-hidden="true">
              {renderSlashHighlightedDraft(props.prompt, mentions.selectedSkillMentions, mentions.selectedPluginMentions)}
            </div>
          )}
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
            selectedParticipantRunLocations={props.selectedParticipantRunLocations}
            renderParticipantAvatar={props.renderParticipantAvatar}
            participantRoleLabel={props.participantRoleLabel}
            onSelectedParticipantIdsChange={props.onSelectedParticipantIdsChange}
            onSelectedParticipantRunLocationsChange={props.onSelectedParticipantRunLocationsChange}
            onOpenParticipantsSettings={props.onOpenParticipantsSettings}
          />
          <button
            type="button"
            className="new-chat-send"
            disabled={!canSubmit}
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

      {readyKinds.length > 0 && validation && <div className="inline-error new-chat-error">{validation}</div>}
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
  assistantParticipant?: ChatParticipantConfig;
  savedParticipantOptions: AddableSavedParticipantConfig[];
  selectedParticipantIds: Set<string>;
  selectedParticipantRunLocations: Record<string, CloudRunRemoteExecutionMode>;
  renderParticipantAvatar: (participant: ChatParticipant) => ReactNode;
  participantRoleLabel: (participant: Pick<ChatParticipant, "roleConfigId">) => string;
  onSelectedParticipantIdsChange: Dispatch<SetStateAction<Set<string>>>;
  onSelectedParticipantRunLocationsChange: Dispatch<SetStateAction<Record<string, CloudRunRemoteExecutionMode>>>;
  onOpenParticipantsSettings: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [expandedParticipantIds, setExpandedParticipantIds] = useState<Set<string>>(() => new Set());
  const rootRef = useCloseOnOutside<HTMLDivElement>(open, () => setOpen(false));
  const participantMenuMaxHeight = useNewChatMenuMaxHeight(rootRef, open);
  const participantOptions: Array<AddableSavedParticipantConfig & { locked?: boolean }> = [
    ...(props.assistantParticipant ? [{ config: props.assistantParticipant, locked: true }] : []),
    ...props.savedParticipantOptions
  ];
  const selectedOptions = participantOptions.filter(({ config, locked }) => locked || props.selectedParticipantIds.has(config.id));
  const selectedCount = selectedOptions.length;
  const label = selectedCount > 0 ? `${selectedCount} member${selectedCount === 1 ? "" : "s"}` : "Add members";

  function toggleParticipant(id: string): void {
    const removing = props.selectedParticipantIds.has(id);
    props.onSelectedParticipantIdsChange((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
    if (removing) {
      props.onSelectedParticipantRunLocationsChange((current) => {
        const { [id]: _removed, ...rest } = current;
        return rest;
      });
    }
  }

  function runLocationFor(participant: ChatParticipantConfig): CloudRunRemoteExecutionMode {
    return normalizeChatRunLocation(props.selectedParticipantRunLocations[participant.id] ?? participant.remoteExecution);
  }

  function updateRunLocation(participant: ChatParticipantConfig, remoteExecution: CloudRunRemoteExecutionMode): void {
    props.onSelectedParticipantRunLocationsChange((current) => ({
      ...current,
      [participant.id]: normalizeChatRunLocation(remoteExecution)
    }));
    props.onSelectedParticipantIdsChange((current) => new Set(current).add(participant.id));
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
            const runLocation = runLocationFor(participant);
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
                    <small>{invalidReason ?? props.participantRoleLabel(participant)}</small>
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
                    {participant.kind === "codex-cli" && !locked && (
                      <label className="new-chat-run-location" title={`Run ${chatRunLocationLabel(runLocation).toLowerCase()}`}>
                        <span>Run</span>
                        <select
                          aria-label={`Run location for @${participant.handle}`}
                          value={runLocation}
                          onChange={(event) => updateRunLocation(participant, event.currentTarget.value as CloudRunRemoteExecutionMode)}
                        >
                          {CHAT_RUN_LOCATION_OPTIONS.map((option) => (
                            <option value={option.value} key={option.value}>{option.label}</option>
                          ))}
                        </select>
                      </label>
                    )}
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

function newChatAssistantParticipant(kind: ChatProviderKind): ChatParticipantConfig {
  return {
    id: NEW_CHAT_ASSISTANT_PARTICIPANT_ID,
    handle: CHAT_ASSISTANT_HANDLE,
    roleConfigId: CHAT_ASSISTANT_ROLE_ID,
    behaviorRuleIds: [],
    kind,
    agentMode: "default",
    permissions: {
      repoRead: false,
      workspaceWrite: false,
      webAccess: false,
      requestParticipants: "ask",
      requestCompaction: "ask",
      shell: {
        enabled: false,
        rules: []
      }
    },
    remoteExecution: "local",
    updatedAt: ""
  };
}

function isNewChatAssistantOption(participant: Pick<ChatParticipantConfig, "id" | "handle" | "roleConfigId">): boolean {
  return participant.id === NEW_CHAT_ASSISTANT_PARTICIPANT_ID || isChatAssistantParticipant(participant);
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
