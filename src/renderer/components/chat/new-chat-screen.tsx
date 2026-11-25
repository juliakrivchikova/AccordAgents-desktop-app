import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  type UIEvent
} from "react";
import { ArrowUpIcon, SquareIcon, CheckIcon, CaretDownIcon, FolderOpenIcon, FolderSimpleIcon, ImageIcon, PlusIcon, XCircleIcon } from "@phosphor-icons/react";

import type {
  AgentHealth,
  AppSettings,
  ChatImageInput,
  ChatParticipant,
  ChatParticipantConfig,
  CliProviderHost,
  ConversationSummary,
  ChatSkillMention,
  GitRepoInfo,
  RepoFileMention
} from "../../../shared/types";
import { IconButton } from "../primitives";
import {
  type AddableSavedParticipantConfig,
  type ChatParticipantRuntimeOverride,
  addableSavedParticipantConfigs,
  selectedOrMentionedChatParticipantDrafts,
  validateChatStartupDrafts
} from "./chat-participant-drafts";
import {
  isNewChatMainSessionOption,
  NEW_CHAT_MAIN_SESSION_PARTICIPANT_ID,
  newChatMainSessionParticipantConfig,
  newChatDesktopStartFor,
  newChatMainSessionParticipantDraft,
  newChatMainSessionPlace
} from "./chat-main-session-draft";
import { startAccessKey, useCliStartDefaults, useMachineList, type NewChatStartAccess } from "./use-cli-start-defaults";
import { participantOptionInvalidReason } from "./chat-cli-readiness";
import {
  assistantSubstituteNote,
  readyProviderKinds,
  resolveAssistantProviderKind
} from "../../../shared/cliReadiness";
import { ChatParticipantSelectableRosterRow } from "./chat-participant-roster-row";
import { CliReadinessSetupPanel } from "./cli-readiness-setup-panel";
import { ChatComposerAttachmentChips } from "./chat-composer-attachment-chips";
import { ChatComposerMenus } from "./chat-composer-menus";
import {
  type DraftPluginMention,
  draftStartsWithPluginMention
} from "./chat-composer-draft-utils";
import { renderSlashHighlightedDraft } from "./chat-composer-draft-highlights";
import { SpeechToTextButton } from "./speech-to-text-button";
import { DICTATION_SESSION_ATTRIBUTE } from "./dictation-target";
import { useChatComposerImages } from "./use-chat-composer-images";
import { useChatComposerMentions } from "./use-chat-composer-mentions";
import { sortSavedParticipantOptionsByUsage } from "./new-chat-participant-usage";
import { useCloseOnOutside, useNewChatMenuMaxHeight } from "./new-chat-menu-hooks";
import { NewChatModelChip } from "./new-chat-model-chip";
import { NewChatRecent } from "./new-chat-recent";
import { ChatCreationStatusLine } from "./chat-creation-state";
import { ComposerBranchMenu, ComposerContextStrip, ComposerFooterSlot } from "./composer-context";
import { FOLDER_BUSY_REASON, folderBusy, normalizeProjectPath, projectLabelForPath } from "../../../shared/newChat";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AccordMergeIcon } from "./accord-merge-icon";
import type { ChatModelAccessPatch } from "./chat-model-access-picker";
import { useComposerNoticeClearance } from "./use-composer-notice-clearance";
import { newChatViewFor } from "../../../shared/mainSession";
import {
  type MainSessionProviderChoice,
  type MainSessionProviderOption,
  mainSessionProviderKey,
  mainSessionProviderOptions,
  resolveMainSessionProvider
} from "../../../shared/mainSessionProviders";
import { Spinner } from "@/components/ui/spinner";

/** Whether the main session's settings on the New chat screen were made for
 *  another provider than the one it is on now (none recorded: made before
 *  any provider was, they are its own). */
export function mainSessionOverrideForOtherProvider(madeFor: string | undefined, providerKey: string | undefined): boolean {
  return Boolean(madeFor) && Boolean(providerKey) && madeFor !== providerKey;
}

const ACCORDAGENTS_MARK_URL = new URL("../../assets/accordagents-mark.png", import.meta.url).href;
const NO_MENTIONS: ChatParticipant[] = [];

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
  selectedParticipantRuntimeOverrides: Record<string, ChatParticipantRuntimeOverride>;
  /** The provider the sessions view's model chip chose for this chat's main
   *  session; none: the one Settings → General names. */
  mainSessionProvider?: MainSessionProviderChoice;
  onMainSessionProviderChange?: (choice: MainSessionProviderChoice | undefined) => void;
  /** The provider (mainSessionProviderKey) the main session's settings on
   *  this screen were made for; settings made for another one are dropped. */
  mainSessionOverrideFor?: string;
  onMainSessionOverrideForChange?: (key: string | undefined) => void;
  /** Told the mode the main session is shown starting in (her CLI config's
   *  where it runs): the chat is made in what was shown. */
  onMainSessionStartAccessChange?: (shown: NewChatStartAccess | undefined) => void;
  settings: AppSettings;
  summaries: ConversationSummary[];
  agents: AgentHealth[];
  busy: boolean;
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
  onSelectedParticipantRuntimeOverridesChange: Dispatch<SetStateAction<Record<string, ChatParticipantRuntimeOverride>>>;
  onOpenParticipantsSettings: () => void;
  /** What a branch switch returns: the folder as it is now. */
  onRepoInfoChange?: (info: GitRepoInfo) => void;
  /** Stops a chat being made (its CLI check or its creation). */
  onStopStart?: () => void;
  /** While the chat is being made: what its preparation is doing. */
  creationStatus?: string;
  /** Opens one of the folder's recent chats listed under the heading. */
  onOpenChat?: (conversationId: string) => void;
  onOpenProviderSettings: () => void;
  onRefreshAgents: () => Promise<AgentHealth[]>;
  onStart: (repoFileMentions?: RepoFileMention[], imageAttachments?: ChatImageInput[], skillMentions?: ChatSkillMention[]) => boolean | void | Promise<boolean | void>;
}): JSX.Element {
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  useComposerNoticeClearance(dockRef);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // A branch switch answers for the folder it was asked for: kept only while
  // that folder is still the one on screen.
  const repoPathRef = useRef(props.repoPath);
  repoPathRef.current = props.repoPath;
  const keepRepoInfo = (info: GitRepoInfo): void => {
    if (normalizeProjectPath(info.repoPath) === normalizeProjectPath(repoPathRef.current)) props.onRepoInfoChange?.(info);
  };
  const shownRepoInfo = props.repoInfo && normalizeProjectPath(props.repoInfo.repoPath) === normalizeProjectPath(props.repoPath) ? props.repoInfo : undefined;
  const [footerSlot, setFooterSlot] = useState<HTMLElement | null>(null);
  const handledPrefillCaretKeyRef = useRef<number | undefined>();
  const images = useChatComposerImages(undefined, {
    pendingImages: props.pendingImages,
    setPendingImages: props.onPendingImagesChange
  });
  const readyKinds = useMemo(
    () => readyProviderKinds(props.agents, props.settings.providers),
    [props.agents, props.settings.providers]
  );
  const assistantProviderKind = useMemo(
    () => resolveAssistantProviderKind({
      agents: props.agents,
      providers: props.settings.providers,
      explicitKind: props.settings.assistantProviderKind
    }),
    [props.agents, props.settings.assistantProviderKind, props.settings.providers]
  );
  // Every new chat opens in the sessions view, whose New chat has no members
  // picker: its composer's controls choose the main session's provider,
  // model, effort and access, as T3 Code's does (the User, 2026-11-21),
  // starting from Settings → General → New chats. The classic branches
  // below are no longer reached (newChatViewFor).
  const sessionsView = newChatViewFor() === "sessions";
  const providerOptions = useMemo(
    () => mainSessionProviderOptions(props.agents, props.settings.providers, props.settings.cliProviderHosts),
    [props.agents, props.settings.cliProviderHosts, props.settings.providers]
  );
  const mainProvider = useMemo<MainSessionProviderOption | undefined>(
    () => sessionsView
      ? resolveMainSessionProvider(props.mainSessionProvider, providerOptions, assistantProviderKind)
      : assistantProviderKind ? { kind: assistantProviderKind, label: "" } : undefined,
    [assistantProviderKind, props.mainSessionProvider, providerOptions, sessionsView]
  );
  const mainKind = mainProvider?.kind;
  const mainHostId = mainProvider?.hostId;
  const chosenProviderInEffect = sessionsView && Boolean(props.mainSessionProvider) && Boolean(mainProvider) &&
    mainSessionProviderKey(mainProvider!) === mainSessionProviderKey(props.mainSessionProvider!);
  // The provider chosen on the chip stopped being ready: said, never taken silently.
  const chosenProviderGone = sessionsView && Boolean(props.mainSessionProvider) && !chosenProviderInEffect;
  // The main session's saved CLI is not ready: this chat takes a ready one, and says so.
  const assistantNote = useMemo(
    () => assistantSubstituteNote({
      agents: props.agents,
      providers: props.settings.providers,
      explicitKind: props.settings.assistantProviderKind
    }),
    [props.agents, props.settings.assistantProviderKind, props.settings.providers]
  );
  // The main session moved to another provider (its saved CLI signed in or
  // out, another one chosen on the chip, or Settings changed while this
  // screen was closed): what was set for it here (model, effort, access,
  // where it runs) was for the one before and is dropped, as the classic
  // New chat always did; another provider's model never reaches a CLI.
  const mainProviderKey = mainProvider ? mainSessionProviderKey(mainProvider) : undefined;
  const { onSelectedParticipantRuntimeOverridesChange } = props;
  // Kept by App so it holds between visits; a screen given no keeper keeps
  // it itself while it is open.
  const ownOverrideFor = useRef<string | undefined>();
  const mainSessionOverrideFor = props.onMainSessionOverrideForChange ? props.mainSessionOverrideFor : ownOverrideFor.current;
  const onMainSessionOverrideForChange = useMemo(
    () => props.onMainSessionOverrideForChange ?? ((key: string | undefined) => { ownOverrideFor.current = key; }),
    [props.onMainSessionOverrideForChange]
  );
  const overrideForOtherProvider = mainSessionOverrideForOtherProvider(mainSessionOverrideFor, mainProviderKey);
  useEffect(() => {
    if (!mainProviderKey || mainSessionOverrideFor === mainProviderKey) return;
    if (mainSessionOverrideFor !== undefined) {
      onSelectedParticipantRuntimeOverridesChange((current) => {
        if (!(NEW_CHAT_MAIN_SESSION_PARTICIPANT_ID in current)) return current;
        const { [NEW_CHAT_MAIN_SESSION_PARTICIPANT_ID]: _forTheOtherProvider, ...rest } = current;
        return rest;
      });
    }
    onMainSessionOverrideForChange?.(mainProviderKey);
  }, [mainProviderKey, mainSessionOverrideFor, onMainSessionOverrideForChange, onSelectedParticipantRuntimeOverridesChange]);
  // Leaving New chat without sending: the chip choice was for the chat about
  // to be made, so the next New chat starts from Settings again.
  const leaveRef = useRef({ sessionsView, onSelectedParticipantRuntimeOverridesChange, onMainSessionProviderChange: props.onMainSessionProviderChange });
  leaveRef.current = { sessionsView, onSelectedParticipantRuntimeOverridesChange, onMainSessionProviderChange: props.onMainSessionProviderChange };
  useEffect(() => () => {
    const leaving = leaveRef.current;
    if (!leaving.sessionsView) return;
    leaving.onMainSessionProviderChange?.(undefined);
    leaving.onSelectedParticipantRuntimeOverridesChange((current) => {
      if (!(NEW_CHAT_MAIN_SESSION_PARTICIPANT_ID in current)) return current;
      const { [NEW_CHAT_MAIN_SESSION_PARTICIPANT_ID]: _chosenForThatChat, ...rest } = current;
      return rest;
    });
  }, []);
  const mainSessionOverride = overrideForOtherProvider ? undefined : props.selectedParticipantRuntimeOverrides[NEW_CHAT_MAIN_SESSION_PARTICIPANT_ID];
  const machineList = useMachineList();
  // How Settings → General → New chats starts it on this provider: the
  // controls start from it (a machine no longer set up: this computer).
  // (useMachineList keeps the same list while nothing it reads changed.)
  const newChatStart = useMemo(
    () => mainKind ? newChatDesktopStartFor(props.settings.newChatDefaults, { kind: mainKind, hostId: mainHostId }, machineList) : undefined,
    [mainHostId, mainKind, machineList, props.settings.newChatDefaults]
  );
  // The mode the User's own config starts its CLI in where the main session
  // runs (this computer, or the machine chosen for it): it starts there.
  const place = newChatMainSessionPlace(mainSessionOverride, newChatStart);
  const startAccess = useCliStartDefaults(mainKind
    ? { kind: mainKind, homeMachineId: place.homeMachineId, cloudRun: place.cloudRun }
    : undefined, machineList)?.access;
  const mainSessionParticipant = useMemo(
    () => mainKind ? newChatMainSessionParticipantConfig(mainKind, Boolean(props.repoPath.trim()), mainHostId, sessionsView, startAccess, newChatStart) : undefined,
    [mainHostId, mainKind, newChatStart, props.repoPath, sessionsView, startAccess]
  );
  const { onMainSessionStartAccessChange } = props;
  const startShownKey = mainProviderKey ? startAccessKey(mainProviderKey, place) : undefined;
  useEffect(() => {
    if (!sessionsView) return;
    onMainSessionStartAccessChange?.(startShownKey ? { key: startShownKey, ...(startAccess ? { access: startAccess } : {}) } : undefined);
  }, [onMainSessionStartAccessChange, sessionsView, startAccess, startShownKey]);
  const savedParticipantOptions = useMemo(
    () => sortSavedParticipantOptionsByUsage(
      addableSavedParticipantConfigs(props.settings, props.agents, new Set())
        .filter(({ config }) => !isNewChatMainSessionOption(config)),
      props.summaries
    ),
    [props.agents, props.settings, props.summaries]
  );
  const mentionParticipants = useMemo<ChatParticipant[]>(
    () => sessionsView ? NO_MENTIONS : [
      ...(mainSessionParticipant ? [mainSessionParticipant] : []),
      ...savedParticipantOptions
        .filter((option) => !participantOptionInvalidReason(option, props.selectedParticipantRuntimeOverrides[option.config.id]))
        .map(({ config }) => config)
    ],
    [mainSessionParticipant, savedParticipantOptions, props.selectedParticipantRuntimeOverrides, sessionsView]
  );
  const mainSessionDraft = useMemo(
    () => mainKind
      ? newChatMainSessionParticipantDraft(mainKind, mainSessionOverride, Boolean(props.repoPath.trim()), mainHostId, sessionsView, startAccess, newChatStart)
      : undefined,
    [mainHostId, mainKind, mainSessionOverride, newChatStart, props.repoPath, sessionsView, startAccess]
  );
  const mainSessionRemote = Boolean(mainSessionDraft?.homeMachineId || mainSessionDraft?.cloudRun);
  const prospectiveParticipantDrafts = useMemo(() => {
    // In the sessions view the chat is made with its main session alone: it
    // makes members itself, and an @handle in the first message picks none.
    const drafts = sessionsView ? [] : selectedOrMentionedChatParticipantDrafts(
      props.settings.chatParticipantConfigs,
      props.selectedParticipantIds,
      props.prompt,
      props.selectedParticipantRuntimeOverrides
    );
    // Every new chat has its main session first (docs/main-session.md).
    return mainSessionDraft ? [mainSessionDraft, ...drafts] : drafts;
  }, [
    mainSessionDraft,
    sessionsView,
    props.prompt,
    props.selectedParticipantIds,
    props.selectedParticipantRuntimeOverrides,
    props.settings.chatParticipantConfigs
  ]);
  const changeMainSession = useCallback((patch: ChatModelAccessPatch) => {
    // "" is the picker's reset to the CLI's own model or effort: none here.
    const settled = Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value === "" ? undefined : value])) as ChatModelAccessPatch;
    onSelectedParticipantRuntimeOverridesChange((current) => ({
      ...current,
      [NEW_CHAT_MAIN_SESSION_PARTICIPANT_ID]: { ...current[NEW_CHAT_MAIN_SESSION_PARTICIPANT_ID], ...settled }
    }));
    if (mainProviderKey) onMainSessionOverrideForChange?.(mainProviderKey);
  }, [mainProviderKey, onMainSessionOverrideForChange, onSelectedParticipantRuntimeOverridesChange]);
  const { onMainSessionProviderChange } = props;
  const chooseMainProvider = useCallback((option: MainSessionProviderOption) => {
    onMainSessionProviderChange?.({ kind: option.kind, ...(option.hostId ? { hostId: option.hostId } : {}) });
  }, [onMainSessionProviderChange]);
  const searchSource = useMemo(
    () => ({
      type: "pre-chat" as const,
      repoPath: props.repoPath.trim() || undefined,
      participants: prospectiveParticipantDrafts,
      assistantProviderKind: mainKind
    }),
    [mainKind, props.repoPath, prospectiveParticipantDrafts]
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
      if (!isNewChatMainSessionOption(participant)) {
        props.onSelectedParticipantIdsChange((current) => new Set(current).add(participant.id));
      }
    }
  });
  const validation = validateChatStartupDrafts(
    prospectiveParticipantDrafts,
    props.settings.chatRoleConfigs,
    props.agents,
    props.settings.chatBehaviorRules,
    props.settings.providers,
    props.settings.cliProviderHosts
  );
  const hasPrompt = props.prompt.trim().length > 0;
  const canSubmit = Boolean(mainKind) && (hasPrompt || images.readyImages.length > 0 || mentions.selectedSkillMentions.length > 0) && !images.hasInvalidImages && !props.busy && !validation;
  const hasLeadingPluginToken = draftStartsWithPluginMention(props.prompt, mentions.selectedPluginMentions);
  const needsProviderSetup = readyKinds.length === 0;

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
    <div className={["new-chat-screen", needsProviderSetup ? "has-cli-readiness" : ""].filter(Boolean).join(" ")} data-testid="new-chat-screen">
      <div className="new-chat-center">
        {needsProviderSetup ? (
          <CliReadinessSetupPanel
            agents={props.agents}
            settings={props.settings}
            checking={props.agents.some((agent) => agent.checking)}
            onRefresh={props.onRefreshAgents}
            onOpenSettings={props.onOpenProviderSettings}
          />
        ) : (
          <>
            <img className="new-chat-mark" src={ACCORDAGENTS_MARK_URL} alt="" aria-hidden="true" draggable="false" />
            <h1 className="new-chat-title">{props.repoPath ? `New chat in ${projectLabelForPath(props.repoPath)}` : "New chat"}</h1>
            <p className="new-chat-hint">Describe the task. / runs a command, # adds a file.</p>
            {props.repoPath && props.onOpenChat && <NewChatRecent summaries={props.summaries} repoPath={props.repoPath} onOpen={props.onOpenChat} />}
          </>
        )}
      </div>

      {/* The composer stands where the chat keeps its own, with the same
          strip, so nothing moves when the chat starts. */}
      <div ref={dockRef} className="new-chat-dock" hidden={needsProviderSetup}>
        {props.repoInfo && !props.repoInfo.isRepo && props.repoInfo.error && (
          <div className="repo-status new-chat-repo-status bad">
            <XCircleIcon size={16} aria-hidden />
            {props.repoInfo.error}
          </div>
        )}

        {readyKinds.length > 0 && validation && <div className="inline-error new-chat-error">{validation}</div>}
        {!needsProviderSetup && chosenProviderGone && mainProvider && (
          <p className="new-chat-assistant-note" data-testid="new-chat-assistant-note">
            {`The provider chosen on the model chip is not ready now: this chat would start on ${mainProvider.label || mainProvider.kind}.`}
          </p>
        )}
        {!needsProviderSetup && !chosenProviderGone && assistantNote && !chosenProviderInEffect && (
          <p className="new-chat-assistant-note" data-testid="new-chat-assistant-note">{assistantNote}</p>
        )}
        {props.creationStatus !== undefined && <ChatCreationStatusLine text={props.creationStatus} />}
        <ChatComposerAttachmentChips
          pendingImages={images.pendingImages}
          removeFileMention={mentions.removeFileMention}
          removePendingImage={images.removePendingImage}
          removeSkillMention={mentions.removeSkillMention}
          selectedFileMentions={mentions.selectedFileMentions}
          selectedSkillMentions={mentions.selectedSkillMentions}
        />
        <ComposerFooterSlot.Provider value={footerSlot}>
        <div className="chat-composer-shell">
        <ComposerContextStrip lead={(
          <>
            <FolderPicker
              repoPath={props.repoPath}
              settings={props.settings}
              onRepoPathChange={props.onRepoPathChange}
              onRepoBlur={props.onRepoBlur}
              onSelectRepo={props.onSelectRepo}
            />
            {/* The folder on screen only (a stale one from before Browse
                must not be switched), and only for a main session on this
                computer: a machine's copy is not this checkout. */}
            {!mainSessionRemote && (
              <ComposerBranchMenu repo={shownRepoInfo} onRepoChange={keepRepoInfo}
                lockedReason={folderBusy(props.summaries, props.repoPath) ? FOLDER_BUSY_REASON : undefined} />
            )}
          </>
        )}>
          {sessionsView ? (mainProvider && mainSessionDraft && (
            <NewChatModelChip
              draft={mainSessionDraft}
              provider={mainProvider}
              providers={providerOptions}
              onProviderChange={chooseMainProvider}
              onChange={changeMainSession}
            />
          )) : <ParticipantPicker
            mainSessionParticipant={mainSessionParticipant}
            savedParticipantOptions={savedParticipantOptions}
            cliProviderHosts={props.settings.cliProviderHosts}
            selectedParticipantIds={props.selectedParticipantIds}
            selectedParticipantRuntimeOverrides={props.selectedParticipantRuntimeOverrides}
            renderParticipantAvatar={props.renderParticipantAvatar}
            participantRoleLabel={props.participantRoleLabel}
            onSelectedParticipantIdsChange={props.onSelectedParticipantIdsChange}
            onSelectedParticipantRuntimeOverridesChange={props.onSelectedParticipantRuntimeOverridesChange}
            onOpenParticipantsSettings={props.onOpenParticipantsSettings}
          />}
        </ComposerContextStrip>
        <div className={["chat-input-wrap", "new-chat-input-wrap", mentions.showSkillHighlights ? "has-skill-highlights" : ""].filter(Boolean).join(" ")} {...{ [DICTATION_SESSION_ATTRIBUTE]: "new-chat" }}>
          <ChatComposerMenus
            fileIndex={mentions.fileIndex}
            insertCommand={mentions.insertCommand}
            insertFileMention={mentions.insertFileMention}
            insertMention={mentions.insertMention}
            insertSavedPrompt={mentions.insertSavedPrompt}
            insertSkillMention={mentions.insertSkillMention}
            insertPluginMention={mentions.insertPluginMention}
            mentionIndex={mentions.mentionIndex}
            mentionOptions={mentions.mentionOptions}
            participantRoleLabel={props.participantRoleLabel}
            renderParticipantAvatar={props.renderParticipantAvatar}
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
            // What was sent at Enter is what the chat starts with.
            readOnly={props.busy}
            placeholder="What are you working on?"
            rows={1}
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
        <div className="chat-composer-toolbar">
          <div className="chat-composer-tools">
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
          <IconButton label="Attach image" icon={ImageIcon} disabled={props.busy} onClick={() => fileInputRef.current?.click()} />
          {/* Where the chat has Start Accord: offered once the chat exists. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="composer-accord-tooltip-trigger">
                <IconButton label="Start Accord" icon={AccordMergeIcon} disabled data-testid="new-chat-accord-button" onClick={() => undefined} />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">Start a chat first: Accord runs in a chat.</TooltipContent>
          </Tooltip>
          </div>
          <div className="chat-composer-actions">
          <span ref={setFooterSlot} className="chat-composer-footer-slot" />
          <SpeechToTextButton
            getTextarea={() => promptRef.current}
            draft={props.prompt}
            onDraftChange={props.onPromptChange}
          />
          {props.busy && props.onStopStart ? (
            // While the chat is being made: Stop, where the chat keeps it.
            <button type="button" className="composer-send-button is-stop" aria-label="Stop" data-testid="new-chat-stop" onClick={props.onStopStart}>
              <SquareIcon size={10} weight="fill" />
            </button>
          ) : (
            <button
              type="button"
              className="composer-send-button"
              disabled={!canSubmit}
              aria-label="Start chat"
              data-testid="new-chat-start"
              onClick={() => void startChat()}
            >
              {props.busy ? <Spinner size={14} /> : <ArrowUpIcon size={14} weight="bold" aria-hidden />}
            </button>
          )}
          </div>
        </div>
        </div>
        </ComposerFooterSlot.Provider>
      </div>

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
        <FolderSimpleIcon size={14} aria-hidden />
        <span>{label}</span>
        <CaretDownIcon size={14} className="text-ui-text-3" aria-hidden />
      </button>
      {open && (
        <div className="new-chat-menu new-chat-folder-menu" role="menu">
          {recentOptions.length > 0 && (
            <>
              <div className="new-chat-menu-section">Recent folders</div>
              {recentOptions.map((path) => (
                <button key={path} type="button" className="new-chat-menu-item" role="menuitem" onClick={() => selectPath(path)}>
                  <FolderOpenIcon size={15} aria-hidden />
                  <span>{folderName(path)}</span>
                  {repoPath === path && <CheckIcon size={14} className="new-chat-menu-check" aria-hidden />}
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
            <PlusIcon size={15} aria-hidden />
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
            <XCircleIcon size={15} aria-hidden />
            <span>Work without a folder</span>
            {!repoPath && <CheckIcon size={14} className="new-chat-menu-check" aria-hidden />}
          </button>
        </div>
      )}
    </div>
  );
}

function ParticipantPicker(props: {
  mainSessionParticipant?: ChatParticipantConfig;
  cliProviderHosts: CliProviderHost[];
  savedParticipantOptions: AddableSavedParticipantConfig[];
  selectedParticipantIds: Set<string>;
  selectedParticipantRuntimeOverrides: Record<string, ChatParticipantRuntimeOverride>;
  renderParticipantAvatar: (participant: ChatParticipant) => ReactNode;
  participantRoleLabel: (participant: Pick<ChatParticipant, "roleConfigId">) => string;
  onSelectedParticipantIdsChange: Dispatch<SetStateAction<Set<string>>>;
  onSelectedParticipantRuntimeOverridesChange: Dispatch<SetStateAction<Record<string, ChatParticipantRuntimeOverride>>>;
  onOpenParticipantsSettings: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useCloseOnOutside<HTMLDivElement>(open, () => setOpen(false));
  const participantMenuMaxHeight = useNewChatMenuMaxHeight(rootRef, open);
  const participantOptions: Array<AddableSavedParticipantConfig & { locked?: boolean }> = [
    ...(props.mainSessionParticipant ? [{ config: props.mainSessionParticipant, locked: true }] : []),
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
      props.onSelectedParticipantRuntimeOverridesChange((current) => {
        const { [id]: _removed, ...rest } = current;
        return rest;
      });
    }
  }

  function runtimeOverrideFor(participant: ChatParticipantConfig): ChatParticipantRuntimeOverride | undefined {
    return props.selectedParticipantRuntimeOverrides[participant.id];
  }

  function updateRuntime(participant: ChatParticipantConfig, patch: Pick<ChatParticipant, "model" | "reasoningEffort" | "agentMode" | "permissions" | "remoteExecution" | "cloudRun" | "homeMachineId" | "skipToolchainPreflight" | "autoWatch">): void {
    const runtimeOverride: ChatParticipantRuntimeOverride = {
      model: patch.model,
      homeMachineId: patch.homeMachineId,
      cloudRun: patch.cloudRun,
      reasoningEffort: patch.reasoningEffort,
      agentMode: patch.agentMode,
      permissions: patch.permissions,
      remoteExecution: patch.remoteExecution,
      skipToolchainPreflight: patch.skipToolchainPreflight,
      autoWatch: patch.autoWatch
    };
    props.onSelectedParticipantRuntimeOverridesChange((current) => ({
      ...current,
      [participant.id]: runtimeOverride
    }));
    // Changing a member's settings adds it, once it can run where they put it.
    const option = participantOptions.find(({ config }) => config.id === participant.id);
    if (option && !isNewChatMainSessionOption(participant) && !participantOptionInvalidReason(option, runtimeOverride)) {
      props.onSelectedParticipantIdsChange((current) => new Set(current).add(participant.id));
    }
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
        <CaretDownIcon size={14} aria-hidden />
      </button>
      {open && (
        <div
          className="new-chat-menu new-chat-participant-menu chat-participant-popover"
          role="menu"
          style={participantMenuMaxHeight === undefined ? undefined : { maxHeight: participantMenuMaxHeight }}
        >
          {participantOptions.length === 0 ? (
            <div className="new-chat-menu-empty">No saved members configured.</div>
          ) : participantOptions.map((option) => {
            const { config: participant, locked } = option;
            const selected = Boolean(locked) || props.selectedParticipantIds.has(participant.id);
            const invalidReason = participantOptionInvalidReason(option, runtimeOverrideFor(participant));
            return (
              <ChatParticipantSelectableRosterRow
                key={participant.id}
                participant={participant}
                cliProviderHosts={props.cliProviderHosts}
                selected={selected}
                locked={locked}
                disabledReason={invalidReason}
                // Where it runs stays choosable while only this computer's CLI is not ready.
                controlsDisabled={Boolean(option.configReason)}
                roleLabel={props.participantRoleLabel(participant)}
                runtimeOverride={runtimeOverrideFor(participant)}
                renderParticipantAvatar={props.renderParticipantAvatar}
                onToggleSelected={() => {
                  if (!locked) {
                    toggleParticipant(participant.id);
                  }
                }}
                onRuntimeChange={updateRuntime}
              />
            );
          })}
          <div className="chat-participant-footer">
            <button
              type="button"
              className="chat-manage-link"
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

function folderName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}
