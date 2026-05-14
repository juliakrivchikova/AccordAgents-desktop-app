import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Circle,
  Columns2,
  Copy,
  FolderOpen,
  HelpCircle,
  KeyRound,
  ListChecks,
  MessageSquare,
  PencilLine,
  Plus,
  Play,
  RefreshCw,
  SendHorizontal,
  Settings,
  Users,
  Maximize2,
  X,
  XCircle
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import {
  Select as UiSelect,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import type {
  AgentHealth,
  AppSettings,
  AppBridge,
  ChatParticipant,
  ChatParticipantConfig,
  ChatParticipantConfigUpdate,
  ChatPendingChoice,
  ChatProviderKind,
  ChatRoleConfig,
  ChatRoleConfigUpdate,
  Conversation,
  ConversationKind,
  ConversationSummary,
  Finding,
  FindingSeverity,
  FindingStatus,
  GitDiffMode,
  GitRepoInfo,
  PlanDecisionAnswer,
  PlanDecisionReply,
  PlanDecisionRequest,
  PlanItemReview,
  ParticipantConfig,
  ProviderKind,
  ProviderModel,
  ProviderSettings,
  ReviewProgress
} from "../shared/types";
import { DEFAULT_NOTICE_CHARS, sanitizeWarningText } from "../shared/warnings";
import { ModeToggle } from "./components/mode-toggle";
import { ThemeProvider } from "./components/theme-provider";
import { DiffModeTabs } from "./components/diff-mode-tabs";
import { AppLoadingState, ChartLoadingState } from "./components/loading-states";
import { SegmentedTabs, type SegmentedTabItem } from "./components/segmented-tabs";
import { SessionModeTabs } from "./components/session-mode-tabs";
import { AppShell, Sidebar, TopBar } from "./components/shell";
import {
  FormRow,
  IconButton,
  LoadingDot,
  Notice,
  ResizableTextarea,
  SeverityBadge,
  StatusBadge,
  type StatusBadgeTone
} from "./components/primitives";
import "./styles/app.css";

const DEFAULT_SETTINGS: AppSettings = {
  roundLimitDefault: 2,
  providers: [],
  chatRoleConfigs: [],
  chatParticipantConfigs: []
};

interface ChatThinkingRow {
  key: string;
  participantId?: string;
  participantLabel: string;
  activity?: string;
  startedAt: string;
  updatedAt: string;
}

const BRANCH_COMPARE_HELP = "Changes committed on the compare branch since it diverged from the base branch.";
const CHAT_CUSTOM_CHOICE_OPTION_ID = "__custom__";

const POINT_SEVERITIES: FindingSeverity[] = ["Critical", "High", "Medium", "Low"];
const MAX_NOTICE_CHARS = DEFAULT_NOTICE_CHARS;
// Judge icon by Freepik - Flaticon: https://www.flaticon.com/free-icon/judge_5452982
const JUDGE_FLATICON_URL = new URL("./assets/judge-flaticon-5452982.png", import.meta.url).href;
// Provider avatars by LobeHub Icons, MIT: https://lobehub.com/icons
const CLAUDE_AVATAR_URL = new URL("./assets/claude-avatar.webp", import.meta.url).href;
const CODEX_AVATAR_URL = new URL("./assets/codex-cli.svg", import.meta.url).href;
const CHAT_AVATAR_URLS = {
  "codex-human": new URL("./assets/participant-codex-human.png", import.meta.url).href,
  "codex-bunny": new URL("./assets/participant-codex-bunny.png", import.meta.url).href,
  "codex-cat": new URL("./assets/participant-codex-cat.png", import.meta.url).href,
  "codex-dog": new URL("./assets/participant-codex-dog.png", import.meta.url).href,
  "codex-frog": new URL("./assets/participant-codex-frog.png", import.meta.url).href,
  "codex-hamster": new URL("./assets/participant-codex-hamster.png", import.meta.url).href,
  "claude-human": new URL("./assets/participant-claude-human.png", import.meta.url).href,
  "claude-bunny": new URL("./assets/participant-claude-bunny.png", import.meta.url).href,
  "claude-cat": new URL("./assets/participant-claude-cat.png", import.meta.url).href,
  "claude-dog": new URL("./assets/participant-claude-dog.png", import.meta.url).href,
  "claude-frog": new URL("./assets/participant-claude-frog.png", import.meta.url).href,
  "claude-hamster": new URL("./assets/participant-claude-hamster.png", import.meta.url).href
} as const;

type ActiveView = "slack" | "points" | "settings";
type ResultView = "slack" | "points";
type SettingsSection = "providers" | "roles" | "participants";
type AvatarKind = "user" | "arbiter" | "anthropic" | "codex" | "gemini" | "generic" | "custom";
type ChatAvatarId = keyof typeof CHAT_AVATAR_URLS;

interface ChatParticipantDraft {
  handle: string;
  roleConfigId: string;
  kind: ChatProviderKind;
  model?: string;
  avatarId?: string;
}

interface AvatarSpec {
  kind: AvatarKind;
  label: string;
  initials?: string;
  imageUrl?: string;
}

interface ChatAvatarOption {
  id: ChatAvatarId;
  kind: ChatProviderKind;
  label: string;
  imageUrl: string;
}

interface AppSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

function AppSelect(props: {
  value: string;
  options: AppSelectOption[];
  placeholder: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  testId?: string;
  onValueChange: (value: string) => void;
}): JSX.Element {
  const selectedValue = props.value || undefined;
  return (
    <UiSelect
      value={selectedValue}
      disabled={props.disabled}
      onValueChange={props.onValueChange}
    >
      <SelectTrigger className={`app-select-trigger ${props.className ?? ""}`} aria-label={props.ariaLabel ?? props.placeholder} data-testid={props.testId}>
        <SelectValue placeholder={props.placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {props.options.map((option) => (
            <SelectItem value={option.value} disabled={option.disabled} key={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </UiSelect>
  );
}

const CHAT_AVATAR_OPTIONS: ChatAvatarOption[] = [
  { id: "codex-human", kind: "codex-cli", label: "Codex human", imageUrl: CHAT_AVATAR_URLS["codex-human"] },
  { id: "codex-bunny", kind: "codex-cli", label: "Codex bunny", imageUrl: CHAT_AVATAR_URLS["codex-bunny"] },
  { id: "codex-cat", kind: "codex-cli", label: "Codex cat", imageUrl: CHAT_AVATAR_URLS["codex-cat"] },
  { id: "codex-dog", kind: "codex-cli", label: "Codex dog", imageUrl: CHAT_AVATAR_URLS["codex-dog"] },
  { id: "codex-frog", kind: "codex-cli", label: "Codex frog", imageUrl: CHAT_AVATAR_URLS["codex-frog"] },
  { id: "codex-hamster", kind: "codex-cli", label: "Codex hamster", imageUrl: CHAT_AVATAR_URLS["codex-hamster"] },
  { id: "claude-human", kind: "claude-code", label: "Claude human", imageUrl: CHAT_AVATAR_URLS["claude-human"] },
  { id: "claude-bunny", kind: "claude-code", label: "Claude bunny", imageUrl: CHAT_AVATAR_URLS["claude-bunny"] },
  { id: "claude-cat", kind: "claude-code", label: "Claude cat", imageUrl: CHAT_AVATAR_URLS["claude-cat"] },
  { id: "claude-dog", kind: "claude-code", label: "Claude dog", imageUrl: CHAT_AVATAR_URLS["claude-dog"] },
  { id: "claude-frog", kind: "claude-code", label: "Claude frog", imageUrl: CHAT_AVATAR_URLS["claude-frog"] },
  { id: "claude-hamster", kind: "claude-code", label: "Claude hamster", imageUrl: CHAT_AVATAR_URLS["claude-hamster"] }
];

const USER_AVATAR: AvatarSpec = { kind: "user", label: "You" };
const ARBITER_AVATAR: AvatarSpec = { kind: "arbiter", label: "Arbiter" };

function providerId(provider: ProviderSettings): string {
  return provider.kind;
}

function isCli(kind: ProviderKind): boolean {
  return kind === "codex-cli" || kind === "claude-code";
}

function waitForNextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function App(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [agents, setAgents] = useState<AgentHealth[]>([]);
  const [summaries, setSummaries] = useState<ConversationSummary[]>([]);
  const [conversation, setConversation] = useState<Conversation | undefined>();
  const [activeView, setActiveView] = useState<ActiveView>("slack");
  const [activeSettingsSection, setActiveSettingsSection] = useState<SettingsSection>("providers");
  const [settingsReturnView, setSettingsReturnView] = useState<ResultView>("slack");
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const [selectedThreadId, setSelectedThreadId] = useState<string | undefined>();
  const [focusedThreadId, setFocusedThreadId] = useState<string | undefined>();
  const [selectedParticipants, setSelectedParticipants] = useState<Set<string>>(new Set());
  const [selectedArbiterId, setSelectedArbiterId] = useState("");
  const [kind, setKind] = useState<ConversationKind>("code-review");
  const [question, setQuestion] = useState("Review these changes and identify concrete bugs or risks.");
  const [repoPath, setRepoPath] = useState("");
  const [repoInfo, setRepoInfo] = useState<GitRepoInfo | undefined>();
  const [diffMode, setDiffMode] = useState<GitDiffMode>("uncommitted");
  const [baseBranch, setBaseBranch] = useState("main");
  const [compareBranch, setCompareBranch] = useState("");
  const [commit, setCommit] = useState("");
  const [pastedDiff, setPastedDiff] = useState("");
  const [diffPreview, setDiffPreview] = useState("");
  const [apiKeyDrafts, setApiKeyDrafts] = useState<Record<string, string>>({});
  const [providerModels, setProviderModels] = useState<Record<string, ProviderModel[]>>({});
  const [modelLoading, setModelLoading] = useState<Record<string, boolean>>({});
  const [modelErrors, setModelErrors] = useState<Record<string, string | undefined>>({});
  const [warnings, setWarnings] = useState<string[]>([]);
  const [initializing, setInitializing] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [openingConversationId, setOpeningConversationId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [currentRunId, setCurrentRunId] = useState<string | undefined>();
  const [progressLog, setProgressLog] = useState<ReviewProgress[]>([]);
  const progressLogRef = useRef<ReviewProgress[]>([]);
  const openConversationRequestRef = useRef(0);
  const [decisionAnswers, setDecisionAnswers] = useState<Record<string, string>>({});
  const [resolvedDecisionThreads, setResolvedDecisionThreads] = useState<Record<string, boolean>>({});
  const [clarificationDrafts, setClarificationDrafts] = useState<Record<string, string>>({});
  const [pendingClarifications, setPendingClarifications] = useState<Record<string, PlanDecisionReply>>({});
  const [planItemReviewDrafts, setPlanItemReviewDrafts] = useState<Record<string, string>>({});
  const [planCorrectionDraft, setPlanCorrectionDraft] = useState("");
  const [selectedChatParticipantConfigIds, setSelectedChatParticipantConfigIds] = useState<Set<string>>(new Set());
  const [chatMessageDraft, setChatMessageDraft] = useState("");
  const [chatAddParticipantDraft, setChatAddParticipantDraft] = useState<ChatParticipantDraft | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    void refreshAll();
  }, []);

  useEffect(() => {
    return window.consensus.onReviewProgress((progress) => {
      setProgressLog((current) => {
        const next = [...current.filter((item) => item.runId === progress.runId), progress];
        progressLogRef.current = next;
        return next;
      });
    });
  }, []);

  useEffect(() => {
    return window.consensus.onConversationUpdated((updated) => {
      setConversation((current) => {
        if (!conversationMatchesSnapshot(current, updated, currentRunId)) {
          return current;
        }
        setSelectedThreadId((selected) => (selected && !threadExistsInConversation(updated, selected) ? undefined : selected));
        setFocusedThreadId((focused) => (focused && !threadExistsInConversation(updated, focused) ? undefined : focused));
        return mergeProgressIntoConversation(updated, progressLogRef.current.filter((item) => item.runId === conversationRunId(updated)));
      });
    });
  }, [currentRunId]);

  useEffect(() => {
    setSelectedParticipants(new Set(settings.providers.filter((provider) => provider.enabled).map(providerId)));
  }, [settings.providers]);

  useEffect(() => {
    setChatAddParticipantDraft((current) => normalizeChatParticipantDraftForSettings(current ?? defaultChatParticipantDraft(settings), settings));
  }, [settings]);

  useEffect(() => {
    const availableIds = new Set(settings.chatParticipantConfigs.map((participant) => participant.id));
    setSelectedChatParticipantConfigIds((current) => new Set([...current].filter((id) => availableIds.has(id))));
  }, [settings.chatParticipantConfigs]);

  useEffect(() => {
    const firstRunnable = settings.providers.find((provider) => !providerDisabledForRun(provider));
    const selectedProvider = settings.providers.find((provider) => providerId(provider) === selectedArbiterId);
    const selectedIsRunnable = Boolean(selectedProvider && !providerDisabledForRun(selectedProvider));
    if (!selectedIsRunnable) {
      setSelectedArbiterId(firstRunnable ? providerId(firstRunnable) : "");
    }
  }, [agents, kind, repoPath, selectedArbiterId, settings.providers]);

  const participantOptions = useMemo(() => {
    return settings.providers.map((provider) => {
      const health = agents.find((agent) => agent.kind === provider.kind);
      const cliWithoutRepo = isCli(provider.kind) && kind === "code-review" && !repoPath.trim();
      const hostedPlanProvider = kind === "implementation-plan" && !isCli(provider.kind);
      return {
        provider,
        disabled: providerDisabledForRun(provider),
        health,
        disabledReason: hostedPlanProvider
          ? "Implementation plans require local repo-aware CLI agents"
          : cliWithoutRepo
            ? "Local CLI agents need a selected repo"
            : isCli(provider.kind) && !health?.installed
              ? `${provider.label} is not installed`
              : undefined
      };
    });
  }, [agents, kind, repoPath, settings.providers]);

  const branchOptions = useMemo(() => {
    if (!repoInfo?.isRepo) {
      return [];
    }
    return repoInfo.branches;
  }, [repoInfo]);

  const branchSelectDisabled = !repoInfo?.isRepo || branchOptions.length === 0;
  const selectedBaseBranch = branchSelectDisabled || !branchOptions.includes(baseBranch) ? "" : baseBranch;
  const selectedCompareBranch = branchSelectDisabled || !branchOptions.includes(compareBranch) ? "" : compareBranch;
  const branchSelectPlaceholder = !repoInfo?.isRepo ? "Select a repository first" : branchOptions.length === 0 ? "No branches found" : "Select branch";
  const arbiterOptions = participantOptions.filter((option) => !option.disabled);
  const arbiterSelectValue = arbiterOptions.some(({ provider }) => providerId(provider) === selectedArbiterId) ? selectedArbiterId : "";
  const arbiterRoleLabel = kind === "implementation-plan" ? "Planner" : "Arbiter";
  const arbiterPlaceholder = kind === "implementation-plan"
    ? "No local CLI agents available"
    : kind === "code-review" && !repoPath.trim()
      ? "Select a repository first"
      : "No runnable providers available";

  async function refreshAll(): Promise<void> {
    setError(undefined);
    setHistoryLoading(true);
    try {
      const [nextSettings, nextAgents, nextSummaries] = await Promise.all([
        window.consensus.getSettings(),
        window.consensus.detectAgents(),
        window.consensus.listConversations()
      ]);
      setSettings(nextSettings);
      setAgents(nextAgents);
      setSummaries(nextSummaries);
      const explicitRepoPath = nextSettings.lastRepoPath?.trim();
      const rememberedRepoPath = explicitRepoPath || nextSummaries.find((summary) => summary.repoPath?.trim())?.repoPath?.trim();
      if (!repoPath.trim() && rememberedRepoPath) {
        setRepoPath(rememberedRepoPath);
        await inspectRepo(rememberedRepoPath, { remember: !explicitRepoPath });
      }
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setInitializing(false);
      setHistoryLoading(false);
    }
  }

  async function openConversation(id: string): Promise<void> {
    const requestId = openConversationRequestRef.current + 1;
    openConversationRequestRef.current = requestId;
    setError(undefined);
    if (conversation?.id === id) {
      setOpeningConversationId(undefined);
      setSettingsMenuOpen(false);
      setActiveView("slack");
      return;
    }
    setOpeningConversationId(id);
    try {
      await waitForNextFrame();
      const next = await window.consensus.getConversation(id);
      if (requestId !== openConversationRequestRef.current) {
        return;
      }
      const nextPendingDecisions = pendingPlanDecisions(next);
      const nextPendingItem = firstPendingPlanItemReview(next);
      setConversation(next);
      if (next) {
        setKind(next.kind);
      }
      progressLogRef.current = [];
      setProgressLog([]);
      setSelectedThreadId(nextPendingDecisions[0]?.id ?? nextPendingItem?.id);
      setFocusedThreadId(undefined);
      setDecisionAnswers(pendingDecisionSelections(next));
      setResolvedDecisionThreads(pendingDecisionResolutions(next));
      setClarificationDrafts({});
      setPendingClarifications({});
      setPlanItemReviewDrafts({});
      setPlanCorrectionDraft("");
      setSettingsMenuOpen(false);
      setActiveView("slack");
    } catch (caught) {
      if (requestId === openConversationRequestRef.current) {
        setError(errorText(caught));
      }
    } finally {
      if (requestId === openConversationRequestRef.current) {
        setOpeningConversationId(undefined);
      }
    }
  }

  async function selectRepo(): Promise<void> {
    const selected = await window.consensus.selectRepoDirectory();
    if (!selected) {
      return;
    }
    setRepoPath(selected);
    await inspectRepo(selected);
  }

  async function inspectRepo(path: string = repoPath, options: { remember?: boolean } = {}): Promise<void> {
    if (!path.trim()) {
      return;
    }
    setError(undefined);
    try {
      const info = await window.consensus.inspectRepo(path.trim());
      setRepoInfo(info);
      if (info.isRepo && options.remember !== false) {
        await rememberRepoPath(info.repoPath || path.trim());
      }
      if (info.isRepo && info.branches.length > 0) {
        const currentBranch = info.currentBranch && info.branches.includes(info.currentBranch) ? info.currentBranch : undefined;
        const defaultCompareBranch = currentBranch ?? info.branches[0];
        const defaultBaseBranch =
          info.branches.find((branch) => branch === "main" && branch !== defaultCompareBranch) ??
          info.branches.find((branch) => branch === "master" && branch !== defaultCompareBranch) ??
          info.branches.find((branch) => branch !== defaultCompareBranch) ??
          defaultCompareBranch;

        setCompareBranch((selected) => (info.branches.includes(selected) ? selected : defaultCompareBranch));
        setBaseBranch((selected) => (info.branches.includes(selected) ? selected : defaultBaseBranch));
      }
    } catch (caught) {
      setError(errorText(caught));
    }
  }

  async function rememberRepoPath(path: string): Promise<void> {
    const normalized = path.trim();
    if (!normalized) {
      return;
    }
    try {
      await window.consensus.updateLastRepoPath(normalized);
      setSettings((current) => ({ ...current, lastRepoPath: normalized }));
    } catch (caught) {
      setError(errorText(caught));
    }
  }

  async function previewDiff(): Promise<void> {
    setError(undefined);
    try {
      const result = await window.consensus.getDiff({
        repoPath,
        mode: diffMode,
        baseBranch,
        compareBranch,
        commit,
        pastedDiff
      });
      setDiffPreview(result.diff || "(empty diff)");
    } catch (caught) {
      setError(errorText(caught));
    }
  }

  async function startReview(): Promise<void> {
    setError(undefined);
    setWarnings([]);
    const arbiter = buildArbiter();
    if (!arbiter) {
      setError(`Select a ${arbiterRoleLabel.toLowerCase()}.`);
      return;
    }
    const participants = buildParticipants();
    if (participants.length === 0) {
      setError("Select at least one participant.");
      return;
    }
    if (kind === "implementation-plan" && participants.length < 2) {
      setError("Select at least two local CLI participants for an implementation plan.");
      return;
    }
    if (kind === "code-review" && diffMode !== "pasted" && !repoPath.trim()) {
      setError("Select a local repository first.");
      return;
    }
    if (kind === "implementation-plan" && !repoPath.trim()) {
      setError("Select a local repository first.");
      return;
    }

    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const requestRepoPath = requiresRepo(kind) ? repoPath.trim() || undefined : undefined;
    setCurrentRunId(runId);
    progressLogRef.current = [];
    setProgressLog([]);
    setSelectedThreadId(undefined);
    setFocusedThreadId(undefined);
    setDecisionAnswers({});
    setResolvedDecisionThreads({});
    setClarificationDrafts({});
    setPendingClarifications({});
    setPlanItemReviewDrafts({});
    setPlanCorrectionDraft("");
    setActiveView("slack");
    setConversation({
      id: runId,
      title: question.trim().slice(0, 80) || titleForKind(kind),
      kind,
      createdAt: startedAt,
      updatedAt: startedAt,
      repoPath: requestRepoPath,
      messages: [
        {
          id: crypto.randomUUID(),
          role: "user",
          content: question || "Review the selected changes.",
          createdAt: startedAt,
          status: "done"
        }
      ],
      findings: [],
      metadata: { runId, running: true }
    });
    setBusy(true);
    try {
      const result = await window.consensus.startReview({
        runId,
        kind,
        question,
        repoPath: requestRepoPath,
        diffMode: kind === "code-review" ? diffMode : undefined,
        baseBranch,
        compareBranch,
        commit,
        pastedDiff,
        participants,
        arbiter,
        roundLimit: settings.roundLimitDefault
      });
      setConversation(mergeProgressIntoConversation(result.conversation, progressLogRef.current.filter((item) => item.runId === runId)));
      setWarnings(result.warnings);
      setDecisionAnswers({});
      setResolvedDecisionThreads({});
      setClarificationDrafts({});
      setPendingClarifications({});
      setPlanItemReviewDrafts({});
      setPlanCorrectionDraft("");
      const nextPendingDecisions = pendingPlanDecisions(result.conversation);
      const nextPendingItem = firstPendingPlanItemReview(result.conversation);
      setSelectedThreadId(nextPendingDecisions[0]?.id ?? nextPendingItem?.id);
      setFocusedThreadId(undefined);
      setActiveView("slack");
      setSummaries(await window.consensus.listConversations());
    } catch (caught) {
      const message = errorText(caught);
      if (message.toLowerCase().includes("cancel")) {
        setWarnings((current) => [...current, "Review cancelled."]);
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
      setCurrentRunId(undefined);
    }
  }

  async function cancelReview(): Promise<void> {
    if (!currentRunId) {
      return;
    }
    await window.consensus.cancelReview(currentRunId);
  }

  async function startChat(): Promise<void> {
    setError(undefined);
    setWarnings([]);
    const participants = selectedChatParticipantDrafts(settings.chatParticipantConfigs, selectedChatParticipantConfigIds);
    const validation = validateChatParticipantDrafts(participants, settings.chatRoleConfigs) ?? validateChatCliAgents(participants, agents);
    if (validation) {
      setError(validation);
      return;
    }
    const runId = crypto.randomUUID();
    setCurrentRunId(runId);
    setBusy(true);
    try {
      const result = await window.consensus.createChatConversation({
        title: question.trim().slice(0, 80) || "Chat",
        repoPath: repoPath.trim() || undefined,
        participants
      });
      setConversation(result.conversation);
      setWarnings(result.warnings);
      setChatMessageDraft("");
      setActiveView("slack");
      setSummaries(await window.consensus.listConversations());
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
      setCurrentRunId(undefined);
    }
  }

  async function sendChatMessage(options: {
    content?: string;
    threadId?: string;
    parentMessageId?: string;
    chatThreadRootId?: string;
  } = {}): Promise<boolean> {
    if (!conversation || conversation.kind !== "chat") {
      return false;
    }
    const content = (options.content ?? chatMessageDraft).trim();
    if (!content) {
      setError("Enter a chat message.");
      return false;
    }
    const runId = crypto.randomUUID();
    setError(undefined);
    setWarnings([]);
    setCurrentRunId(runId);
    progressLogRef.current = [];
    setProgressLog([]);
    setBusy(true);
    if (!options.chatThreadRootId) {
      setChatMessageDraft("");
    }
    try {
      const result = await window.consensus.sendChatMessage({
        conversationId: conversation.id,
        runId,
        content,
        threadId: options.threadId,
        parentMessageId: options.parentMessageId,
        chatThreadRootId: options.chatThreadRootId
      });
      setConversation(mergeProgressIntoConversation(result.conversation, progressLogRef.current.filter((item) => item.runId === runId)));
      setWarnings(result.warnings);
      setSummaries(await window.consensus.listConversations());
      return true;
    } catch (caught) {
      const message = errorText(caught);
      if (message.toLowerCase().includes("cancel")) {
        setWarnings((current) => [...current, "Chat turn cancelled."]);
      } else {
        setError(message);
      }
      return false;
    } finally {
      setBusy(false);
      setCurrentRunId(undefined);
    }
  }

  async function respondToChatMentions(sourceMessageId: string, targetParticipantIds: string[], approve: boolean, continueRequester = false): Promise<void> {
    if (!conversation || conversation.kind !== "chat") {
      return;
    }
    const runId = crypto.randomUUID();
    setError(undefined);
    setWarnings([]);
    setCurrentRunId(runId);
    progressLogRef.current = [];
    setProgressLog([]);
    setBusy(true);
    try {
      const result = await window.consensus.respondToChatMentions({
        conversationId: conversation.id,
        sourceMessageId,
        targetParticipantIds,
        approve,
        continueRequester,
        runId
      });
      setConversation(mergeProgressIntoConversation(result.conversation, progressLogRef.current.filter((item) => item.runId === runId)));
      setWarnings(result.warnings);
      setSummaries(await window.consensus.listConversations());
    } catch (caught) {
      const message = errorText(caught);
      if (message.toLowerCase().includes("cancel")) {
        setWarnings((current) => [...current, "Mention approval run cancelled."]);
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
      setCurrentRunId(undefined);
    }
  }

  async function respondToChatChoice(
    sourceMessageId: string,
    choiceId: string,
    response: { selectedOptionId?: string; customAnswer?: string; note?: string }
  ): Promise<void> {
    if (!conversation || conversation.kind !== "chat") {
      return;
    }
    const runId = crypto.randomUUID();
    setError(undefined);
    setWarnings([]);
    setCurrentRunId(runId);
    progressLogRef.current = [];
    setProgressLog([]);
    setBusy(true);
    try {
      const result = await window.consensus.respondToChatChoice({
        conversationId: conversation.id,
        sourceMessageId,
        choiceId,
        ...response,
        runId
      });
      setConversation(mergeProgressIntoConversation(result.conversation, progressLogRef.current.filter((item) => item.runId === runId)));
      setWarnings(result.warnings);
      setSummaries(await window.consensus.listConversations());
    } catch (caught) {
      const message = errorText(caught);
      if (message.toLowerCase().includes("cancel")) {
        setWarnings((current) => [...current, "Choice response cancelled."]);
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
      setCurrentRunId(undefined);
    }
  }

  async function addChatParticipant(): Promise<void> {
    if (!conversation || conversation.kind !== "chat" || !chatAddParticipantDraft) {
      return;
    }
    const participant = normalizedChatDrafts([chatAddParticipantDraft])[0];
    const existingHandles = new Set(chatParticipants(conversation).map((item) => item.handle.toLowerCase()));
    const validation = validateChatParticipantDrafts([participant], settings.chatRoleConfigs, existingHandles) ?? validateChatCliAgents([participant], agents);
    if (validation) {
      setError(validation);
      return;
    }
    setError(undefined);
    try {
      const saved = await window.consensus.addChatParticipant({ conversationId: conversation.id, participant });
      if (saved) {
        setConversation(saved);
      }
      setChatAddParticipantDraft(defaultChatParticipantDraft(settings));
      setSummaries(await window.consensus.listConversations());
    } catch (caught) {
      setError(errorText(caught));
    }
  }

  async function continueReview(): Promise<void> {
    const pendingDecisions = pendingPlanDecisions(conversation);
    if (!conversation || pendingDecisions.length === 0) {
      return;
    }
    const decisionReplies = planDecisionReplies(conversation);
    const savedAnswers = implementationPlanAnswers(conversation);
    const currentDecisionAnswers = { ...pendingDecisionSelections(conversation), ...decisionAnswers };
    const currentDecisionResolutions = { ...pendingDecisionResolutions(conversation), ...resolvedDecisionThreads };
    const hasAnyDecisionInput = pendingDecisions.some((decision) =>
      decisionThreadIsReady(decision, currentDecisionAnswers, currentDecisionResolutions, savedAnswers)
    );
    if (!hasAnyDecisionInput) {
      setError("Choose an option or resolve at least one decision thread.");
      return;
    }

    const runId = crypto.randomUUID();
    const answers: PlanDecisionAnswer[] = pendingDecisions.flatMap((decision) => {
      const savedAnswer = decisionAnswerForDecision(decision, savedAnswers);
      const selectedOptionId = currentDecisionAnswers[decision.id] ?? savedAnswer?.selectedOptionId;
      const option = decision.options.find((item) => item.id === selectedOptionId);
      const hasFreshInput = decisionThreadIsReady(decision, currentDecisionAnswers, currentDecisionResolutions);
      if (!hasFreshInput && savedAnswer) {
        return [savedAnswer];
      }
      if (!hasFreshInput) {
        return [];
      }
      const answerSelection = selectedOptionId ? { ...currentDecisionAnswers, [decision.id]: selectedOptionId } : currentDecisionAnswers;
      const generatedAnswer = decisionThreadAnswer(decision, answerSelection, decisionReplies);
      return [{
        decisionId: decision.id,
        decisionKey: planDecisionKey(decision),
        selectedOptionId: option ? selectedOptionId : undefined,
        answer: generatedAnswer,
        answerSource: "user"
      }];
    });
    const optimisticAnswers = mergePlanDecisionAnswers(savedAnswers, answers);
    const optimisticDecisionRequests = mergePlanDecisionRequests(planDecisionRequests(conversation), pendingDecisions);

    setError(undefined);
    setWarnings([]);
    setCurrentRunId(runId);
    progressLogRef.current = [];
    setProgressLog([]);
    setConversation((current) =>
      current?.id === conversation.id
        ? {
            ...current,
            metadata: {
              ...current.metadata,
              implementationPlanAnswers: optimisticAnswers,
              planDecisionRequests: optimisticDecisionRequests,
              pendingDecisionSelections: undefined,
              pendingDecisionResolutions: undefined,
              pendingDecisions: undefined,
              running: true
            }
          }
        : current
    );
    setBusy(true);
    try {
      const result = await window.consensus.continueReview({ conversationId: conversation.id, runId, answers });
      setConversation(mergeProgressIntoConversation(result.conversation, progressLogRef.current.filter((item) => item.runId === runId)));
      setWarnings(result.warnings);
      setDecisionAnswers({});
      setResolvedDecisionThreads({});
      setClarificationDrafts({});
      setPendingClarifications({});
      setPlanItemReviewDrafts({});
      setPlanCorrectionDraft("");
      const nextPendingDecisions = pendingPlanDecisions(result.conversation);
      const nextPendingItem = firstPendingPlanItemReview(result.conversation);
      setSelectedThreadId(nextPendingDecisions[0]?.id ?? nextPendingItem?.id);
      setFocusedThreadId(undefined);
      setActiveView("slack");
      setSummaries(await window.consensus.listConversations());
    } catch (caught) {
      const message = errorText(caught);
      if (message.toLowerCase().includes("cancel")) {
        setWarnings((current) => [...current, "Review cancelled."]);
      } else {
        setError(message);
      }
      setConversation((current) =>
        current?.id === conversation.id
          ? {
              ...current,
              metadata: {
                ...current.metadata,
                implementationPlanAnswers: optimisticAnswers,
                planDecisionRequests: optimisticDecisionRequests,
                pendingDecisionSelections: currentDecisionAnswers,
                pendingDecisionResolutions: currentDecisionResolutions,
                pendingDecisions,
                running: false
              }
            }
          : current
      );
    } finally {
      setBusy(false);
      setCurrentRunId(undefined);
      setConversation((current) =>
        current?.id === conversation.id && current.metadata.running === true
          ? { ...current, metadata: { ...current.metadata, running: false } }
          : current
      );
    }
  }

  async function selectDecisionAnswer(decisionId: string, optionId: string): Promise<void> {
    if (!conversation) {
      return;
    }
    const nextAnswers = { ...pendingDecisionSelections(conversation), ...decisionAnswers, [decisionId]: optionId };
    setDecisionAnswers(nextAnswers);
    setConversation((current) =>
      current?.id === conversation.id
        ? { ...current, metadata: { ...current.metadata, pendingDecisionSelections: nextAnswers } }
        : current
    );
    try {
      const saved = await window.consensus.saveDecisionSelections(conversation.id, nextAnswers);
      if (saved) {
        setConversation((current) => current?.id === saved.id ? { ...saved, messages: current.messages, findings: current.findings } : current);
      }
      setSummaries(await window.consensus.listConversations());
    } catch (caught) {
      setError(`Could not save decision selection: ${errorText(caught)}`);
    }
  }

  async function resolveDecisionThread(decisionId: string): Promise<void> {
    if (!conversation) {
      return;
    }
    setError(undefined);
    const nextResolutions = { ...pendingDecisionResolutions(conversation), ...resolvedDecisionThreads, [decisionId]: true };
    setResolvedDecisionThreads(nextResolutions);
    setConversation((current) =>
      current?.id === conversation.id
        ? { ...current, metadata: { ...current.metadata, pendingDecisionResolutions: nextResolutions } }
        : current
    );
    try {
      const saved = await window.consensus.saveDecisionResolutions(conversation.id, nextResolutions);
      if (saved) {
        setConversation((current) => current?.id === saved.id ? { ...saved, messages: current.messages, findings: current.findings } : current);
      }
      setSummaries(await window.consensus.listConversations());
    } catch (caught) {
      setError(`Could not save decision resolution: ${errorText(caught)}`);
    }
  }

  async function askDecisionClarification(decisionId: string): Promise<void> {
    if (!conversation) {
      return;
    }
    const question = clarificationDrafts[decisionId]?.trim();
    if (!question) {
      setError("Enter a thread message.");
      return;
    }

    const runId = crypto.randomUUID();
    const pendingReply: PlanDecisionReply = {
      id: `pending:${runId}`,
      decisionId,
      role: "user",
      content: question,
      createdAt: new Date().toISOString(),
      status: "done"
    };
    setError(undefined);
    setCurrentRunId(runId);
    setSelectedThreadId(decisionId);
    setFocusedThreadId(decisionId);
    setClarificationDrafts((current) => ({ ...current, [decisionId]: "" }));
    setPendingClarifications((current) => ({ ...current, [decisionId]: pendingReply }));
    progressLogRef.current = [];
    setProgressLog([]);
    setBusy(true);
    try {
      const result = await window.consensus.askPlanDecisionClarification({
        conversationId: conversation.id,
        decisionId,
        question,
        runId
      });
      setConversation(mergeProgressIntoConversation(result.conversation, progressLogRef.current.filter((item) => item.runId === runId)));
      setWarnings(result.warnings);
      setClarificationDrafts((current) => ({ ...current, [decisionId]: "" }));
      setPendingClarifications((current) => {
        const next = { ...current };
        delete next[decisionId];
        return next;
      });
      setSelectedThreadId(decisionId);
      setFocusedThreadId(decisionId);
      setSummaries(await window.consensus.listConversations());
    } catch (caught) {
      const message = errorText(caught);
      if (message.toLowerCase().includes("cancel")) {
        setWarnings((current) => [...current, "Clarification cancelled."]);
      } else {
        setError(message);
      }
      setClarificationDrafts((current) => ({ ...current, [decisionId]: question }));
    } finally {
      setBusy(false);
      setCurrentRunId(undefined);
      setPendingClarifications((current) => {
        const next = { ...current };
        delete next[decisionId];
        return next;
      });
    }
  }

  async function confirmPlanItem(findingId: string): Promise<void> {
    if (!conversation) {
      return;
    }
    setError(undefined);
    try {
      const saved = await window.consensus.savePlanItemReview({
        conversationId: conversation.id,
        findingId,
        confirmed: true
      });
      if (saved) {
        setConversation(saved);
      }
      setSummaries(await window.consensus.listConversations());
    } catch (caught) {
      setError(errorText(caught));
    }
  }

  async function commentOnPlanItem(findingId: string): Promise<void> {
    if (!conversation) {
      return;
    }
    const comment = planItemReviewDrafts[findingId]?.trim();
    if (!comment) {
      setError("Enter an item comment.");
      return;
    }
    setError(undefined);
    try {
      const saved = await window.consensus.savePlanItemReview({
        conversationId: conversation.id,
        findingId,
        comment
      });
      if (saved) {
        setConversation(saved);
      }
      setPlanItemReviewDrafts((current) => ({ ...current, [findingId]: "" }));
      setSummaries(await window.consensus.listConversations());
    } catch (caught) {
      setError(errorText(caught));
    }
  }

  async function composeImplementationPlan(): Promise<void> {
    if (!conversation) {
      return;
    }
    const runId = crypto.randomUUID();
    setError(undefined);
    setWarnings([]);
    setCurrentRunId(runId);
    progressLogRef.current = [];
    setProgressLog([]);
    setBusy(true);
    setConversation((current) =>
      current?.id === conversation.id
        ? {
            ...current,
            metadata: {
              ...current.metadata,
              running: true
            }
          }
        : current
    );
    try {
      const result = await window.consensus.composeImplementationPlan({ conversationId: conversation.id, runId });
      setConversation(mergeProgressIntoConversation(result.conversation, progressLogRef.current.filter((item) => item.runId === runId)));
      setWarnings(result.warnings);
      setSelectedThreadId(undefined);
      setFocusedThreadId(undefined);
      setActiveView("slack");
      setSummaries(await window.consensus.listConversations());
    } catch (caught) {
      const message = errorText(caught);
      if (message.toLowerCase().includes("cancel")) {
        setWarnings((current) => [...current, "Plan composition cancelled."]);
      } else {
        setError(message);
      }
      setConversation((current) =>
        current?.id === conversation.id
          ? {
              ...current,
              metadata: {
                ...current.metadata,
                running: false
              }
            }
          : current
      );
    } finally {
      setBusy(false);
      setCurrentRunId(undefined);
      setConversation((current) =>
        current?.id === conversation.id && current.metadata.running === true
          ? { ...current, metadata: { ...current.metadata, running: false } }
          : current
      );
    }
  }

  async function retryFinalPlanSynthesis(): Promise<void> {
    if (!conversation) {
      return;
    }
    const runId = crypto.randomUUID();
    setError(undefined);
    setWarnings([]);
    setCurrentRunId(runId);
    progressLogRef.current = [];
    setProgressLog([]);
    setBusy(true);
    setActiveView("slack");
    setConversation((current) =>
      current?.id === conversation.id
        ? {
            ...current,
            metadata: {
              ...current.metadata,
              running: true
            }
          }
        : current
    );
    try {
      const result = await window.consensus.retryImplementationPlanSynthesis({ conversationId: conversation.id, runId });
      setConversation(mergeProgressIntoConversation(result.conversation, progressLogRef.current.filter((item) => item.runId === runId)));
      setWarnings(result.warnings);
      setSummaries(await window.consensus.listConversations());
    } catch (caught) {
      const message = errorText(caught);
      if (message.toLowerCase().includes("cancel")) {
        setWarnings((current) => [...current, "Final plan retry cancelled."]);
      } else {
        setError(message);
      }
      setConversation((current) =>
        current?.id === conversation.id
          ? {
              ...current,
              metadata: {
                ...current.metadata,
                running: false
              }
            }
          : current
      );
    } finally {
      setBusy(false);
      setCurrentRunId(undefined);
      setConversation((current) =>
        current?.id === conversation.id && current.metadata.running === true
          ? { ...current, metadata: { ...current.metadata, running: false } }
          : current
      );
    }
  }

  async function recoverImplementationPlan(): Promise<void> {
    if (!conversation) {
      return;
    }
    const runId = crypto.randomUUID();
    setError(undefined);
    setWarnings([]);
    setCurrentRunId(runId);
    progressLogRef.current = [];
    setProgressLog([]);
    setBusy(true);
    setActiveView("slack");
    setConversation((current) =>
      current?.id === conversation.id
        ? {
            ...current,
            metadata: {
              ...current.metadata,
              running: true
            }
          }
        : current
    );
    try {
      const result = await window.consensus.recoverImplementationPlan({ conversationId: conversation.id, runId });
      setConversation(mergeProgressIntoConversation(result.conversation, progressLogRef.current.filter((item) => item.runId === runId)));
      setWarnings(result.warnings);
      const nextPendingDecisions = pendingPlanDecisions(result.conversation);
      const nextPendingItem = firstPendingPlanItemReview(result.conversation);
      setSelectedThreadId(nextPendingDecisions[0]?.id ?? nextPendingItem?.id);
      setFocusedThreadId(undefined);
      setSummaries(await window.consensus.listConversations());
    } catch (caught) {
      const message = errorText(caught);
      if (message.toLowerCase().includes("cancel")) {
        setWarnings((current) => [...current, "Plan recovery cancelled."]);
      } else {
        setError(message);
      }
      setConversation((current) =>
        current?.id === conversation.id
          ? {
              ...current,
              metadata: {
                ...current.metadata,
                running: false
              }
            }
          : current
      );
    } finally {
      setBusy(false);
      setCurrentRunId(undefined);
      setConversation((current) =>
        current?.id === conversation.id && current.metadata.running === true
          ? { ...current, metadata: { ...current.metadata, running: false } }
          : current
      );
    }
  }

  async function reviseImplementationPlan(): Promise<void> {
    if (!conversation) {
      return;
    }
    const instruction = planCorrectionDraft.trim();
    if (!instruction) {
      setError("Enter a plan correction.");
      return;
    }
    const runId = crypto.randomUUID();
    setError(undefined);
    setWarnings([]);
    setCurrentRunId(runId);
    progressLogRef.current = [];
    setProgressLog([]);
    setBusy(true);
    setActiveView("slack");
    setConversation((current) =>
      current?.id === conversation.id
        ? {
            ...current,
            metadata: {
              ...current.metadata,
              running: true
            }
          }
        : current
    );
    try {
      const result = await window.consensus.reviseImplementationPlan({
        conversationId: conversation.id,
        instruction,
        runId
      });
      setConversation(mergeProgressIntoConversation(result.conversation, progressLogRef.current.filter((item) => item.runId === runId)));
      setWarnings(result.warnings);
      setPlanCorrectionDraft("");
      setSummaries(await window.consensus.listConversations());
    } catch (caught) {
      const message = errorText(caught);
      if (message.toLowerCase().includes("cancel")) {
        setWarnings((current) => [...current, "Final plan revision cancelled."]);
      } else {
        setError(message);
      }
      setConversation((current) =>
        current?.id === conversation.id
          ? {
              ...current,
              metadata: {
                ...current.metadata,
                running: false
              }
            }
          : current
      );
    } finally {
      setBusy(false);
      setCurrentRunId(undefined);
      setConversation((current) =>
        current?.id === conversation.id && current.metadata.running === true
          ? { ...current, metadata: { ...current.metadata, running: false } }
          : current
      );
    }
  }

  function newReview(): void {
    if (busy) {
      return;
    }
    setConversation(undefined);
    progressLogRef.current = [];
    setProgressLog([]);
    setSelectedThreadId(undefined);
    setFocusedThreadId(undefined);
    setWarnings([]);
    setDecisionAnswers({});
    setResolvedDecisionThreads({});
    setClarificationDrafts({});
    setPendingClarifications({});
    setPlanItemReviewDrafts({});
    setPlanCorrectionDraft("");
    setChatMessageDraft("");
    setChatAddParticipantDraft(defaultChatParticipantDraft(settings));
    setError(undefined);
    setSettingsMenuOpen(false);
    setActiveView("slack");
  }

  function buildParticipants(): ParticipantConfig[] {
    return settings.providers
      .filter((provider) => selectedParticipants.has(providerId(provider)))
      .filter((provider) => !providerDisabledForRun(provider))
      .filter((provider) => kind !== "implementation-plan" || isCli(provider.kind))
      .filter((provider) => !(isCli(provider.kind) && requiresRepo(kind) && !repoPath.trim()))
      .map((provider) => ({
        id: provider.kind,
        kind: provider.kind,
        label: provider.label,
        model: provider.model
      }));
  }

  function buildArbiter(): ParticipantConfig | undefined {
    const provider = settings.providers.find((item) => providerId(item) === selectedArbiterId);
    if (!provider || providerDisabledForRun(provider)) {
      return undefined;
    }
    return {
      id: provider.kind,
      kind: provider.kind,
      label: provider.label,
      model: provider.model
    };
  }

  function providerDisabledForRun(provider: ProviderSettings): boolean {
    const health = agents.find((agent) => agent.kind === provider.kind);
    if (kind === "implementation-plan" && !isCli(provider.kind)) {
      return true;
    }
    if (isCli(provider.kind)) {
      return !health?.installed || (kind === "code-review" && !repoPath.trim());
    }
    return !provider.hasApiKey;
  }

  function toggleParticipant(provider: ProviderSettings): void {
    if (providerDisabledForRun(provider)) {
      return;
    }
    setSelectedParticipants((current) => {
      const next = new Set(current);
      const id = providerId(provider);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  async function updateProvider(provider: ProviderSettings, patch: { enabled?: boolean; model?: string; apiKey?: string; clearApiKey?: boolean }): Promise<void> {
    setError(undefined);
    try {
      const next = await window.consensus.updateProviderSettings({ kind: provider.kind, ...patch });
      setSettings(next);
      if (patch.apiKey) {
        setApiKeyDrafts((current) => ({ ...current, [provider.kind]: "" }));
        await refreshProviderModels(provider.kind);
      }
      if (patch.clearApiKey) {
        setProviderModels((current) => ({ ...current, [provider.kind]: [] }));
      }
    } catch (caught) {
      setError(errorText(caught));
    }
  }

  async function refreshProviderModels(kind: ProviderKind): Promise<void> {
    setModelLoading((current) => ({ ...current, [kind]: true }));
    setModelErrors((current) => ({ ...current, [kind]: undefined }));
    try {
      const models = await window.consensus.listProviderModels(kind);
      setProviderModels((current) => ({ ...current, [kind]: models }));
      if (models.length === 0) {
        setModelErrors((current) => ({ ...current, [kind]: "No compatible text models were returned." }));
      }
    } catch (caught) {
      setModelErrors((current) => ({ ...current, [kind]: errorText(caught) }));
    } finally {
      setModelLoading((current) => ({ ...current, [kind]: false }));
    }
  }

  async function saveChatRoleConfig(update: ChatRoleConfigUpdate): Promise<void> {
    setError(undefined);
    try {
      const next = await window.consensus.saveChatRoleConfig(update);
      setSettings(next);
    } catch (caught) {
      setError(errorText(caught));
    }
  }

  async function saveChatParticipantConfig(update: ChatParticipantConfigUpdate): Promise<void> {
    setError(undefined);
    try {
      const next = await window.consensus.saveChatParticipantConfig(update);
      setSettings(next);
      if (!update.id) {
        const created = next.chatParticipantConfigs.find((participant) => participant.handle.toLowerCase() === update.handle.trim().replace(/^@/, "").toLowerCase());
        if (created) {
          setSelectedChatParticipantConfigIds((current) => new Set([...current, created.id]));
        }
      }
    } catch (caught) {
      setError(errorText(caught));
    }
  }

  async function deleteChatParticipantConfig(id: string): Promise<void> {
    setError(undefined);
    try {
      const next = await window.consensus.deleteChatParticipantConfig(id);
      setSettings(next);
      setSelectedChatParticipantConfigIds((current) => {
        const nextIds = new Set(current);
        nextIds.delete(id);
        return nextIds;
      });
    } catch (caught) {
      setError(errorText(caught));
    }
  }

  const openingConversation = openingConversationId ? summaries.find((summary) => summary.id === openingConversationId) : undefined;
  const isOpeningConversation = Boolean(openingConversationId);
  const openingConversationDescription = openingConversation
    ? `${labelForKind(openingConversation.kind)} · ${openingConversation.title}`
    : "Opening the selected conversation from history.";
  const hasResultContext = Boolean(conversation) || busy || isOpeningConversation;
  const pendingDecisions = pendingPlanDecisions(conversation);
  const reviewablePlanItems = requiredPlanItemReviewFindings(conversation);
  const reviewedPlanItemCount = reviewablePlanItems.filter((finding) => planItemReviewForFinding(finding, planItemReviews(conversation))).length;
  const isPendingPlanItemReview = pendingPlanItemReview(conversation);
  const canComposePlan = isPendingPlanItemReview && reviewedPlanItemCount === reviewablePlanItems.length;
  const canRecoverPlan = canRecoverImplementationPlan(conversation, busy);
  const visibleDecisionAnswers = { ...pendingDecisionSelections(conversation), ...decisionAnswers };
  const visibleDecisionResolutions = { ...pendingDecisionResolutions(conversation), ...resolvedDecisionThreads };
  const conversationKind = conversation?.kind ?? openingConversation?.kind ?? kind;
  const visibleWarnings = warnings.map((warning) => displayNoticeText(warning)).filter(Boolean);
  const resultView: ResultView = activeView === "points" && conversationKind !== "implementation-plan" && conversationKind !== "chat" ? "points" : "slack";
  const hasPoints = Boolean(conversation && conversation.kind !== "chat" && conversation.metadata.running !== true && pendingDecisions.length === 0);
  const runnableParticipants = buildParticipants();
  const hasRequiredContext =
    kind === "code-review" ? diffMode === "pasted" || Boolean(repoPath.trim()) : kind !== "implementation-plan" || Boolean(repoPath.trim());
  const canStart = !busy && hasRequiredContext && Boolean(buildArbiter()) && runnableParticipants.length > 0 && (kind !== "implementation-plan" || runnableParticipants.length >= 2);

  const resultTabItems: Array<SegmentedTabItem<ResultView>> = [
    { value: "slack", label: "Slack", icon: MessageSquare, testId: "result-view-tab-slack" },
    ...(hasPoints && conversationKind !== "implementation-plan" && conversationKind !== "chat"
      ? [{ value: "points" as const, label: "Points", icon: ListChecks, testId: "result-view-tab-points" }]
      : [])
  ];
  const topBarTabs = hasResultContext ? (
    <SegmentedTabs
      value={resultView}
      items={resultTabItems}
      ariaLabel="Result view"
      className="topbar-result-tabs"
      minItemWidth={96}
      onValueChange={setActiveView}
    />
  ) : null;
  const openSettingsSection = (section: SettingsSection): void => {
    if (activeView !== "settings") {
      setSettingsReturnView(activeView === "points" ? "points" : "slack");
    }
    setActiveSettingsSection(section);
    setActiveView("settings");
    setSettingsMenuOpen(false);
  };
  const closeSettings = (): void => {
    setActiveView(settingsReturnView === "points" && !hasPoints ? "slack" : settingsReturnView);
  };

  const topBarActions = (
    <>
      {busy && (
        <Button variant="outline" size="sm" onClick={() => void cancelReview()}>
          <XCircle aria-hidden />
          Stop
        </Button>
      )}
      <ModeToggle />
      <DropdownMenu open={settingsMenuOpen} onOpenChange={setSettingsMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant={activeView === "settings" || settingsMenuOpen ? "default" : "outline"}
            size="icon-sm"
            title="Settings"
            aria-label="Settings"
            data-testid="settings-menu-trigger"
          >
            <Settings aria-hidden />
            <span className="sr-only">Settings</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            <DropdownMenuItem
              onClick={() => {
                openSettingsSection("providers");
              }}
            >
              <KeyRound aria-hidden />
              Providers
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                openSettingsSection("roles");
              }}
            >
              <Circle aria-hidden />
              Roles
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                openSettingsSection("participants");
              }}
            >
              <Users aria-hidden />
              Participants
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="outline" size="icon-sm" title="Refresh" aria-label="Refresh" onClick={() => void refreshAll()}>
        <RefreshCw aria-hidden />
        <span className="sr-only">Refresh</span>
      </Button>
    </>
  );

  return (
    <AppShell
      sidebar={
        <Sidebar
          conversations={summaries}
          activeId={conversation?.id}
          pendingId={openingConversationId}
          busy={busy}
          loading={historyLoading}
          onSelect={(id) => void openConversation(id)}
          onNewSession={newReview}
        />
      }
      topBar={
        <TopBar tabs={topBarTabs} title={hasResultContext ? undefined : "New session"} actions={topBarActions} />
      }
    >

        {error && (
          <div className="mx-3 mt-2">
            <Notice tone="error">{displayNoticeText(error)}</Notice>
          </div>
        )}
        {visibleWarnings.map((warning, index) => (
          <div className="mx-3 mt-2" key={`${index}:${warning.slice(0, 80)}`}>
            <Notice tone="warning">{warning}</Notice>
          </div>
        ))}

        {activeView === "settings" ? (
          <SettingsView
            section={activeSettingsSection}
            settings={settings}
            agents={agents}
            apiKeyDrafts={apiKeyDrafts}
            providerModels={providerModels}
            modelLoading={modelLoading}
            modelErrors={modelErrors}
            setApiKeyDrafts={setApiKeyDrafts}
            updateProvider={updateProvider}
            refreshProviderModels={refreshProviderModels}
            saveChatRoleConfig={saveChatRoleConfig}
            saveChatParticipantConfig={saveChatParticipantConfig}
            deleteChatParticipantConfig={deleteChatParticipantConfig}
            onClose={closeSettings}
          />
        ) : initializing ? (
          <div className="content-area compose-layout">
            <AppLoadingState />
          </div>
        ) : (
          <div className={`content-area ${hasResultContext ? "result-layout" : "compose-layout"}`}>
            {!hasResultContext && (
            <section className="composer">
              <SessionModeTabs value={kind} onValueChange={setKind} />

              {kind === "chat" ? (
                <ChatSetup
                  title={question}
                  repoPath={repoPath}
                  repoInfo={repoInfo}
                  selectedParticipantIds={selectedChatParticipantConfigIds}
                  settings={settings}
                  agents={agents}
                  busy={busy}
                  onTitleChange={setQuestion}
                  onRepoPathChange={(value) => {
                    setRepoPath(value);
                    setRepoInfo(undefined);
                  }}
                  onRepoBlur={() => void inspectRepo()}
                  onSelectRepo={() => void selectRepo()}
                  onSelectedParticipantIdsChange={setSelectedChatParticipantConfigIds}
                  onOpenParticipantsSettings={() => {
                    openSettingsSection("participants");
                  }}
                  onStart={() => void startChat()}
                />
              ) : (
                <>
                  <FormRow label="Prompt">
                    <ResizableTextarea
                      value={question}
                      onChange={(event) => setQuestion(event.target.value)}
                      rows={5}
                      maxHeight={360}
                    />
                  </FormRow>

                  {requiresRepo(kind) && (
                    <>
                      <div className="flex items-end gap-2">
                        <FormRow label="Repository" className="flex-1">
                          <Input
                            value={repoPath}
                            onChange={(event) => {
                              setRepoPath(event.target.value);
                              setRepoInfo(undefined);
                            }}
                            onBlur={() => void inspectRepo()}
                          />
                        </FormRow>
                        <IconButton
                          size="sm"
                          icon={FolderOpen}
                          label="Select repository"
                          tooltip="Select repository"
                          variant="outline"
                          onClick={() => void selectRepo()}
                        />
                      </div>
                      {repoInfo && (
                        <div className={`repo-status ${repoInfo.isRepo ? "ok" : "bad"}`}>
                          {repoInfo.isRepo ? (
                            <>
                              <CheckCircle2 size={16} />
                              {repoInfo.currentBranch || "detached"} · {repoInfo.statusLines.length} changed paths
                            </>
                          ) : (
                            <>
                              <XCircle size={16} />
                              {repoInfo.error || "Not a git repository"}
                            </>
                          )}
                        </div>
                      )}

                      {kind === "code-review" && (
                        <>
                          <FormRow label="Diff mode">
                            <DiffModeTabs value={diffMode} onValueChange={setDiffMode} />
                          </FormRow>

                          {diffMode === "base" && (
                            <FormRow label="Branches" hint={BRANCH_COMPARE_HELP}>
                              <div className="grid grid-cols-2 gap-2">
                                <FormRow label="Base branch">
                                  <AppSelect
                                    value={selectedBaseBranch}
                                    disabled={branchSelectDisabled}
                                    placeholder={branchSelectPlaceholder}
                                    ariaLabel="Base branch"
                                    testId="base-branch-select"
                                    options={branchOptions.map((branch) => ({ value: branch, label: branch }))}
                                    onValueChange={setBaseBranch}
                                  />
                                </FormRow>
                                <FormRow label="Compare branch">
                                  <AppSelect
                                    value={selectedCompareBranch}
                                    disabled={branchSelectDisabled}
                                    placeholder={branchSelectPlaceholder}
                                    ariaLabel="Compare branch"
                                    testId="compare-branch-select"
                                    options={branchOptions.map((branch) => ({ value: branch, label: branch }))}
                                    onValueChange={setCompareBranch}
                                  />
                                </FormRow>
                              </div>
                            </FormRow>
                          )}
                          {diffMode === "commit" && (
                            <FormRow label="Commit SHA">
                              <Input value={commit} onChange={(event) => setCommit(event.target.value)} />
                            </FormRow>
                          )}
                          {diffMode === "pasted" && (
                            <FormRow label="Pasted diff">
                              <ResizableTextarea
                                value={pastedDiff}
                                onChange={(event) => setPastedDiff(event.target.value)}
                                rows={7}
                                maxHeight={420}
                              />
                            </FormRow>
                          )}

                          <Button variant="outline" size="sm" onClick={() => void previewDiff()}>
                            Preview diff
                          </Button>
                          {diffPreview && (
                            <pre className="max-h-[280px] overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed">
                              {diffPreview.slice(0, 6000)}
                            </pre>
                          )}
                        </>
                      )}
                    </>
                  )}

                  <div className="participant-picker">
                    <span>Participants</span>
                    {participantOptions.map(({ provider, disabled, health, disabledReason }) => {
                      const selected = selectedParticipants.has(providerId(provider)) && !disabled;
                      return (
                        <button
                          key={provider.kind}
                          className={`participant-pill ${selected ? "selected" : ""}`}
                          disabled={disabled}
                          onClick={() => toggleParticipant(provider)}
                          title={disabledReason ?? provider.model ?? provider.label}
                        >
                          {selected ? <CheckCircle2 size={15} /> : <Circle size={15} />}
                          {provider.label}
                          {providerId(provider) === selectedArbiterId && (
                            <small>{selected ? `also ${arbiterRoleLabel.toLowerCase()}` : `${arbiterRoleLabel.toLowerCase()} only`}</small>
                          )}
                          {disabledReason ? <small>{disabledReason}</small> : isCli(provider.kind) && <small>{health?.installed ? "local" : "missing"}</small>}
                        </button>
                      );
                    })}
                  </div>

                  <FormRow
                    label={arbiterRoleLabel}
                    hint={`The ${arbiterRoleLabel.toLowerCase()} merge is a separate run. If the same provider is selected as a participant, it also gets an independent participant run.`}
                  >
                    <AppSelect
                      value={arbiterSelectValue}
                      disabled={arbiterOptions.length === 0}
                      placeholder={arbiterPlaceholder}
                      ariaLabel={arbiterRoleLabel}
                      testId="arbiter-select"
                      options={arbiterOptions.map(({ provider }) => ({ value: providerId(provider), label: provider.label }))}
                      onValueChange={setSelectedArbiterId}
                    />
                  </FormRow>

                  <Button
                    type="button"
                    disabled={!canStart}
                    onClick={() => void startReview()}
                    className="mt-2 w-full"
                  >
                    {busy ? <RefreshCw className="animate-spin" aria-hidden /> : <Play aria-hidden />}
                    {busy ? "Running consensus..." : "Start consensus"}
                  </Button>
                </>
              )}
            </section>
            )}

            {hasResultContext && (
              <section className={`conversation-panel ${conversationKind === "chat" ? "chat-conversation-panel" : ""}`}>
                {isOpeningConversation ? (
                  <AppLoadingState title="Loading chat" description={openingConversationDescription} />
                ) : conversationKind === "chat" && conversation ? (
                  <ChatConversationView
                    conversation={conversation}
                    settings={settings}
                    agents={agents}
                    progress={progressLog}
                    isRunning={busy}
                    draft={chatMessageDraft}
                    addParticipantDraft={chatAddParticipantDraft ?? defaultChatParticipantDraft(settings)}
                    onDraftChange={setChatMessageDraft}
                    onSend={() => sendChatMessage()}
                    onSendThread={(rootMessage, content) => sendChatMessage({
                      content,
                      threadId: rootMessage.metadata?.threadId ?? rootMessage.id,
                      parentMessageId: rootMessage.id,
                      chatThreadRootId: rootMessage.id
                    })}
                    onApproveMentions={(sourceMessageId, targetParticipantIds, continueRequester) =>
                      void respondToChatMentions(sourceMessageId, targetParticipantIds, true, continueRequester)
                    }
                    onRejectMentions={(sourceMessageId, targetParticipantIds) =>
                      void respondToChatMentions(sourceMessageId, targetParticipantIds, false)
                    }
                    onRespondToChoice={(sourceMessageId, choiceId, response) =>
                      void respondToChatChoice(sourceMessageId, choiceId, response)
                    }
                    onAddParticipantDraftChange={setChatAddParticipantDraft}
                    onAddParticipant={() => void addChatParticipant()}
                  />
                ) : resultView === "slack" && (
                  <SlackView
                    conversation={conversation}
                    progress={progressLog}
                    kind={conversationKind}
                    isRunning={busy}
                    selectedThreadId={selectedThreadId}
                    focusedThreadId={focusedThreadId}
                    onSelectThread={(id) => {
                      setSelectedThreadId(id);
                      if (!id) {
                        setFocusedThreadId(undefined);
                      }
                    }}
                    onFocusThread={(id) => {
                      setSelectedThreadId(id);
                      setFocusedThreadId(id);
                    }}
                    onExitFocus={() => setFocusedThreadId(undefined)}
                    onCloseThread={() => {
                      setSelectedThreadId(undefined);
                      setFocusedThreadId(undefined);
                    }}
                    pendingDecisions={pendingDecisions}
                    decisionReplies={[...planDecisionReplies(conversation), ...Object.values(pendingClarifications)]}
                    decisionAnswers={visibleDecisionAnswers}
                    decisionResolutions={visibleDecisionResolutions}
                    clarificationDrafts={clarificationDrafts}
                    planItemReviewDrafts={planItemReviewDrafts}
                    planCorrectionDraft={planCorrectionDraft}
                    canComposePlan={canComposePlan}
                    reviewedPlanItemCount={reviewedPlanItemCount}
                    reviewablePlanItemCount={reviewablePlanItems.length}
                    canRecoverPlan={canRecoverPlan}
                    onDecisionAnswer={(decisionId, optionId) => void selectDecisionAnswer(decisionId, optionId)}
                    onResolveDecision={(decisionId) => void resolveDecisionThread(decisionId)}
                    onClarificationDraftChange={(decisionId, value) => setClarificationDrafts((current) => ({ ...current, [decisionId]: value }))}
                    onAskClarification={(decisionId) => void askDecisionClarification(decisionId)}
                    onPlanItemReviewDraftChange={(findingId, value) => setPlanItemReviewDrafts((current) => ({ ...current, [findingId]: value }))}
                    onConfirmPlanItem={(findingId) => void confirmPlanItem(findingId)}
                    onCommentPlanItem={(findingId) => void commentOnPlanItem(findingId)}
                    onPlanCorrectionDraftChange={setPlanCorrectionDraft}
                    onContinue={() => void continueReview()}
                    onComposePlan={() => void composeImplementationPlan()}
                    onRetryFinalPlan={() => void retryFinalPlanSynthesis()}
                    onRecoverPlan={() => void recoverImplementationPlan()}
                    onRevisePlan={() => void reviseImplementationPlan()}
                  />
                )}
                {resultView === "points" && <PointsView conversation={conversation} kind={conversationKind} isRunning={busy} />}
              </section>
            )}
          </div>
        )}
    </AppShell>
  );
}

function SettingsView(props: {
  section: SettingsSection;
  settings: AppSettings;
  agents: AgentHealth[];
  apiKeyDrafts: Record<string, string>;
  providerModels: Record<string, ProviderModel[]>;
  modelLoading: Record<string, boolean>;
  modelErrors: Record<string, string | undefined>;
  setApiKeyDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  updateProvider: (provider: ProviderSettings, patch: { enabled?: boolean; model?: string; apiKey?: string; clearApiKey?: boolean }) => Promise<void>;
  refreshProviderModels: (kind: ProviderKind) => Promise<void>;
  saveChatRoleConfig: (update: ChatRoleConfigUpdate) => Promise<void>;
  saveChatParticipantConfig: (update: ChatParticipantConfigUpdate) => Promise<void>;
  deleteChatParticipantConfig: (id: string) => Promise<void>;
  onClose: () => void;
}): JSX.Element {
  const title = props.section === "providers" ? "Providers" : props.section === "roles" ? "Roles" : "Participants";
  return (
    <section className="settings-view">
      <div className="settings-view-head">
        <h1>{title}</h1>
        <IconButton
          size="sm"
          icon={X}
          label="Close settings"
          tooltip="Close settings"
          variant="outline"
          onClick={props.onClose}
        />
      </div>
      {props.section === "roles" && (
        <section className="settings-section">
          <div className="settings-section-head">
            <h2>Chat roles</h2>
            <span>{props.settings.chatRoleConfigs.length} roles</span>
          </div>
          <div className="role-config-list">
            {props.settings.chatRoleConfigs.map((role) => (
              <ChatRoleEditor role={role} onSave={props.saveChatRoleConfig} key={role.id} />
            ))}
            <ChatRoleEditor onSave={props.saveChatRoleConfig} key={`new-role-${props.settings.chatRoleConfigs.length}`} />
          </div>
        </section>
      )}
      {props.section === "participants" && (
        <ParticipantSettingsSection
          settings={props.settings}
          agents={props.agents}
          onSave={props.saveChatParticipantConfig}
          onDelete={props.deleteChatParticipantConfig}
        />
      )}
      {props.section === "providers" && (
        <section className="settings-section">
          <div className="settings-section-head">
            <h2>Providers</h2>
            <span>{props.settings.providers.length} providers</span>
          </div>
          <div className="settings-grid">
            {props.settings.providers.map((provider) => {
              const health = props.agents.find((agent) => agent.kind === provider.kind);
              const models = props.providerModels[provider.kind] ?? [];
              const isLoadingModels = Boolean(props.modelLoading[provider.kind]);
              const modelError = props.modelErrors[provider.kind];
              const hasDraftKey = Boolean(props.apiKeyDrafts[provider.kind]?.trim());
              return (
                <div className="settings-item" key={provider.kind}>
                  <div className="settings-item-head">
                    <div>
                      <strong>{provider.label}</strong>
                      <small>{isCli(provider.kind) ? healthLine(health) : provider.hasApiKey ? "API key saved" : "No API key saved"}</small>
                    </div>
                    <label className="toggle">
                      <input
                        type="checkbox"
                        checked={provider.enabled}
                        onChange={(event) => void props.updateProvider(provider, { enabled: event.target.checked })}
                      />
                      <span />
                    </label>
                  </div>

                  {!isCli(provider.kind) && (
                    <>
                      <div className="flex items-end gap-2">
                        <FormRow label="Model" className="flex-1">
                          {models.length > 0 ? (
                            <AppSelect
                              value={provider.model && models.some((model) => model.id === provider.model) ? provider.model : "__custom__"}
                              placeholder="Select model"
                              ariaLabel={`${provider.label} model`}
                              testId={`${provider.kind}-model-select`}
                              options={[
                                ...models.map((model) => ({ value: model.id, label: model.label })),
                                { value: "__custom__", label: "Custom model ID..." }
                              ]}
                              onValueChange={(value) => {
                                if (value !== "__custom__") {
                                  void props.updateProvider(provider, { model: value });
                                }
                              }}
                            />
                          ) : (
                            <Input
                              value={provider.model ?? ""}
                              onChange={(event) => void props.updateProvider(provider, { model: event.target.value })}
                              placeholder={provider.hasApiKey ? "Fetch models or enter a custom model id" : "Save an API key first"}
                            />
                          )}
                        </FormRow>
                        <IconButton
                          size="sm"
                          icon={RefreshCw}
                          iconClassName={isLoadingModels ? "animate-spin" : undefined}
                          label="Fetch available models"
                          tooltip="Fetch available models"
                          variant="outline"
                          disabled={!provider.hasApiKey || isLoadingModels}
                          onClick={() => void props.refreshProviderModels(provider.kind)}
                        />
                      </div>
                      {models.length > 0 && !models.some((model) => model.id === provider.model) && (
                        <FormRow label="Custom model ID">
                          <Input
                            value={provider.model ?? ""}
                            onChange={(event) => void props.updateProvider(provider, { model: event.target.value })}
                          />
                        </FormRow>
                      )}
                      {modelError && <div className="inline-error">{modelError}</div>}
                      <div className="flex items-end gap-2">
                        <FormRow label="API key" className="flex-1">
                          <Input
                            type="password"
                            value={props.apiKeyDrafts[provider.kind] ?? ""}
                            onChange={(event) =>
                              props.setApiKeyDrafts((current) => ({ ...current, [provider.kind]: event.target.value }))
                            }
                          />
                        </FormRow>
                        <Button
                          size="sm"
                          title="Save API key"
                          disabled={!hasDraftKey}
                          onClick={() => void props.updateProvider(provider, { apiKey: props.apiKeyDrafts[provider.kind] ?? "" })}
                        >
                          <KeyRound aria-hidden />
                          Save key
                        </Button>
                      </div>
                      {hasDraftKey && <div className="inline-warning">Unsaved API key entered.</div>}
                      {provider.hasApiKey && (
                        <Button variant="outline" size="sm" onClick={() => void props.updateProvider(provider, { clearApiKey: true })}>
                          Clear saved key
                        </Button>
                      )}
                    </>
                  )}
                </div>
              );
            })}
            </div>
        </section>
      )}
    </section>
  );
}

function ParticipantSettingsSection(props: {
  settings: AppSettings;
  agents: AgentHealth[];
  onSave: (update: ChatParticipantConfigUpdate) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}): JSX.Element {
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h2>Chat participants</h2>
        <span>{props.settings.chatParticipantConfigs.length} saved</span>
      </div>
      <div className="role-config-list">
        {props.settings.chatParticipantConfigs.map((participant) => (
          <ChatParticipantConfigEditor
            participant={participant}
            settings={props.settings}
            agents={props.agents}
            onSave={props.onSave}
            onDelete={props.onDelete}
            key={participant.id}
          />
        ))}
        <ChatParticipantConfigEditor
          settings={props.settings}
          agents={props.agents}
          onSave={props.onSave}
          onDelete={props.onDelete}
          key={`new-participant-${props.settings.chatParticipantConfigs.length}`}
        />
      </div>
    </section>
  );
}

function ChatParticipantConfigEditor(props: {
  participant?: ChatParticipantConfig;
  settings: AppSettings;
  agents: AgentHealth[];
  onSave: (update: ChatParticipantConfigUpdate) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}): JSX.Element {
  const existingHandles = new Set(
    props.settings.chatParticipantConfigs
      .filter((participant) => participant.id !== props.participant?.id)
      .map((participant) => participant.handle.toLowerCase())
  );
  const [draft, setDraft] = useState<ChatParticipantDraft>(
    props.participant ? chatParticipantConfigToDraft(props.participant) : defaultChatParticipantDraft(props.settings, existingHandles)
  );
  const normalized = normalizedChatDrafts([draft])[0];
  const changed = !props.participant || !sameParticipantDraft(normalized, props.participant);
  const validation = validateChatParticipantDrafts([normalized], props.settings.chatRoleConfigs, existingHandles) ?? validateChatCliAgents([normalized], props.agents);
  const canSave = changed && !validation;

  useEffect(() => {
    setDraft(props.participant ? chatParticipantConfigToDraft(props.participant) : defaultChatParticipantDraft(props.settings, existingHandles));
  }, [props.participant, props.settings]);

  return (
    <article className="role-config-card participant-config-card">
      <div className="settings-item-head">
        <div>
          <strong>{props.participant ? `@${props.participant.handle}` : "New participant"}</strong>
          <small>{props.participant ? chatRoleLabel(props.settings.chatRoleConfigs, props.participant) : "saved chat template"}</small>
        </div>
        <div className="settings-item-actions">
          {props.participant && (
            <ConfirmDeleteButton
              label="Delete"
              title={`Delete @${props.participant.handle}?`}
              description="This participant will be removed from saved chat participants and unselected from chats that use it."
              confirmLabel="Delete participant"
              onConfirm={() => props.onDelete(props.participant!.id)}
            />
          )}
          <Button
            variant="outline" size="sm"
            disabled={!canSave}
            onClick={() => void props.onSave({ id: props.participant?.id, ...normalized })}
          >
            <CheckCircle2 size={16} />
            Save
          </Button>
        </div>
      </div>
      <ChatParticipantDraftRow draft={draft} settings={props.settings} agents={props.agents} onChange={setDraft} />
      {validation && <div className="inline-error">{validation}</div>}
    </article>
  );
}

function ConfirmDeleteButton(props: {
  label: string;
  title: string;
  description: string;
  confirmLabel?: string;
  onConfirm: () => Promise<void>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  const confirm = async (): Promise<void> => {
    setPending(true);
    try {
      await props.onConfirm();
      setOpen(false);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="destructive" size="sm">
          <X size={16} />
          {props.label}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>{props.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" size="sm" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button variant="destructive" size="sm" disabled={pending} onClick={() => void confirm()}>
            <X size={16} />
            {pending ? "Deleting..." : props.confirmLabel ?? props.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChatRoleEditor({ role, onSave }: { role?: ChatRoleConfig; onSave: (update: ChatRoleConfigUpdate) => Promise<void> }): JSX.Element {
  const [label, setLabel] = useState(role?.label ?? "");
  const [instructions, setInstructions] = useState(role?.instructions ?? "");
  const changed = label.trim() !== (role?.label ?? "") || instructions.trim() !== (role?.instructions ?? "");
  const canSave = Boolean(label.trim() && instructions.trim()) && (!role || changed);
  return (
    <article className="role-config-card">
      <div className="settings-item-head">
        <div>
          <strong>{role ? role.label : "New role"}</strong>
          <small>{role ? `v${role.version}${role.builtIn ? " built-in" : ""}` : "custom"}</small>
        </div>
        <Button variant="outline" size="sm" disabled={!canSave} onClick={() => void onSave({ id: role?.id, label, instructions })}>
          <CheckCircle2 size={16} />
          Save
        </Button>
      </div>
      <FormRow label="Name">
        <Input value={label} onChange={(event) => setLabel(event.target.value)} />
      </FormRow>
      <FormRow label="Instructions">
        <ResizableTextarea
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          rows={4}
          maxHeight={320}
        />
      </FormRow>
    </article>
  );
}

function ChatSetup(props: {
  title: string;
  repoPath: string;
  repoInfo?: GitRepoInfo;
  selectedParticipantIds: Set<string>;
  settings: AppSettings;
  agents: AgentHealth[];
  busy: boolean;
  onTitleChange: (value: string) => void;
  onRepoPathChange: (value: string) => void;
  onRepoBlur: () => void;
  onSelectRepo: () => void;
  onSelectedParticipantIdsChange: React.Dispatch<React.SetStateAction<Set<string>>>;
  onOpenParticipantsSettings: () => void;
  onStart: () => void;
}): JSX.Element {
  const normalizedDrafts = selectedChatParticipantDrafts(props.settings.chatParticipantConfigs, props.selectedParticipantIds);
  const validation = validateChatParticipantDrafts(normalizedDrafts, props.settings.chatRoleConfigs) ?? validateChatCliAgents(normalizedDrafts, props.agents);
  const allParticipantIds = props.settings.chatParticipantConfigs
    .filter((participant) => {
      const draft = chatParticipantConfigToDraft(participant);
      return !(validateChatParticipantDrafts([draft], props.settings.chatRoleConfigs) ?? validateChatCliAgents([draft], props.agents));
    })
    .map((participant) => participant.id);
  return (
    <div className="chat-setup">
      <FormRow label="Chat title">
        <Input value={props.title} onChange={(event) => props.onTitleChange(event.target.value)} />
      </FormRow>
      <div className="flex items-end gap-2">
        <FormRow label="Repository" optional className="flex-1">
          <Input value={props.repoPath} onChange={(event) => props.onRepoPathChange(event.target.value)} onBlur={props.onRepoBlur} />
        </FormRow>
        <IconButton
          size="sm"
          icon={FolderOpen}
          label="Select repository"
          tooltip="Select repository"
          variant="outline"
          onClick={props.onSelectRepo}
        />
      </div>
      {props.repoInfo && (
        <div className={`repo-status ${props.repoInfo.isRepo ? "ok" : "bad"}`}>
          {props.repoInfo.isRepo ? (
            <>
              <CheckCircle2 size={16} />
              {props.repoInfo.currentBranch || "detached"} · {props.repoInfo.statusLines.length} changed paths
            </>
          ) : (
            <>
              <XCircle size={16} />
              {props.repoInfo.error || "Not a git repository"}
            </>
          )}
        </div>
      )}
      <div className="chat-roster-editor">
        <div className="settings-section-head">
          <h2>Participants</h2>
          <div className="settings-item-actions">
            <Button variant="outline" size="sm" onClick={() => props.onSelectedParticipantIdsChange(new Set(allParticipantIds))}>
              <Users size={16} />
              Select all
            </Button>
            <Button variant="outline" size="sm" onClick={() => props.onSelectedParticipantIdsChange(new Set())}>
              <X size={16} />
              Clear
            </Button>
            <Button variant="outline" size="sm" onClick={props.onOpenParticipantsSettings}>
              <Plus size={16} />
              New participant
            </Button>
          </div>
        </div>
        {props.settings.chatParticipantConfigs.length === 0 ? (
          <div className="empty-state">
            No saved participants yet. Create participants in Settings, then select them here for each chat.
          </div>
        ) : (
          <div className="chat-participant-select-list">
            {props.settings.chatParticipantConfigs.map((participant) => {
              const draft = chatParticipantConfigToDraft(participant);
              const invalidReason = validateChatParticipantDrafts([draft], props.settings.chatRoleConfigs) ?? validateChatCliAgents([draft], props.agents);
              const selected = props.selectedParticipantIds.has(participant.id);
              return (
                <label className={`saved-participant-option ${selected ? "selected" : ""} ${invalidReason ? "disabled" : ""}`} key={participant.id}>
                  <input
                    type="checkbox"
                    checked={selected}
                    disabled={Boolean(invalidReason)}
                    onChange={(event) => {
                      props.onSelectedParticipantIdsChange((current) => {
                        const next = new Set(current);
                        if (event.target.checked) {
                          next.add(participant.id);
                        } else {
                          next.delete(participant.id);
                        }
                        return next;
                      });
                    }}
                  />
                  <Avatar className="mini-avatar" spec={avatarForChatParticipant(participant)} />
                  <strong>@{participant.handle}</strong>
                  <span>{chatRoleLabel(props.settings.chatRoleConfigs, participant)} · {labelForProviderKind(props.settings.providers, participant.kind)}</span>
                  {invalidReason && <small>{invalidReason}</small>}
                </label>
              );
            })}
          </div>
        )}
      </div>
      {validation && <div className="inline-error">{validation}</div>}
      <Button className="w-full" disabled={props.busy || Boolean(validation)} onClick={props.onStart}>
        {props.busy ? <RefreshCw size={17} className="spin" /> : <Play size={17} />}
        {props.busy ? "Starting chat..." : "Start chat"}
      </Button>
    </div>
  );
}

function ChatParticipantDraftRow(props: {
  draft: ChatParticipantDraft;
  settings: AppSettings;
  agents: AgentHealth[];
  removable?: boolean;
  onChange: (draft: ChatParticipantDraft) => void;
  onRemove?: () => void;
}): JSX.Element {
  const cliProviders = props.settings.providers.filter((provider) => isCli(provider.kind));
  const avatarId = normalizedChatAvatarId(props.draft.kind, props.draft.avatarId, props.draft.handle);
  const avatarOptions = chatAvatarOptionsForKind(props.draft.kind);
  return (
    <div className="chat-participant-row">
      <FormRow label="Name">
        <Input
          value={props.draft.handle}
          onChange={(event) => props.onChange({ ...props.draft, handle: event.target.value })}
          placeholder="eng1"
        />
      </FormRow>
      <FormRow label="Role">
        <AppSelect
          value={props.draft.roleConfigId}
          placeholder="Select role"
          ariaLabel="Participant role"
          options={props.settings.chatRoleConfigs.map((role) => ({ value: role.id, label: role.label }))}
          onValueChange={(value) => props.onChange(updateChatParticipantDraft(props.draft, props.settings, { roleConfigId: value }))}
        />
      </FormRow>
      <FormRow label="CLI">
        <AppSelect
          value={props.draft.kind}
          placeholder="Select CLI"
          ariaLabel="Participant CLI"
          options={cliProviders.map((provider) => {
            const health = props.agents.find((agent) => agent.kind === provider.kind);
            return {
              value: provider.kind,
              label: `${provider.label}${health?.installed ? "" : " (missing)"}`,
              disabled: !health?.installed
            };
          })}
          onValueChange={(value) => props.onChange(updateChatParticipantDraft(props.draft, props.settings, { kind: value as ChatProviderKind }))}
        />
      </FormRow>
      <FormRow label="Model">
        <Input
          value={props.draft.model ?? ""}
          onChange={(event) => props.onChange({ ...props.draft, model: event.target.value })}
          placeholder="CLI default"
        />
      </FormRow>
      <FormRow label="Avatar" className="avatar-picker-field">
        <div className="avatar-choice-grid" role="radiogroup" aria-label="Participant avatar">
          {avatarOptions.map((option) => {
            const selected = option.id === avatarId;
            return (
              <button
                type="button"
                className={`avatar-choice ${selected ? "selected" : ""}`}
                title={option.label}
                aria-label={option.label}
                aria-pressed={selected}
                onClick={() => props.onChange(updateChatParticipantDraft(props.draft, props.settings, { avatarId: option.id }))}
                key={option.id}
              >
                <Avatar className="avatar-choice-preview" spec={avatarForChatAvatarOption(option)} />
              </button>
            );
          })}
        </div>
      </FormRow>
      {props.removable && (
        <IconButton
          size="xs"
          icon={X}
          label="Remove participant"
          tooltip="Remove participant"
          onClick={props.onRemove}
          className="chat-row-remove"
        />
      )}
    </div>
  );
}

function ChatConversationView(props: {
  conversation: Conversation;
  settings: AppSettings;
  agents: AgentHealth[];
  progress: ReviewProgress[];
  isRunning: boolean;
  draft: string;
  addParticipantDraft: ChatParticipantDraft;
  onDraftChange: (value: string) => void;
  onSend: () => Promise<boolean>;
  onSendThread: (rootMessage: Conversation["messages"][number], content: string) => Promise<boolean>;
  onApproveMentions: (sourceMessageId: string, targetParticipantIds: string[], continueRequester: boolean) => void;
  onRejectMentions: (sourceMessageId: string, targetParticipantIds: string[]) => void;
  onRespondToChoice: (sourceMessageId: string, choiceId: string, response: { selectedOptionId?: string; customAnswer?: string; note?: string }) => void;
  onAddParticipantDraftChange: (draft: ChatParticipantDraft) => void;
  onAddParticipant: () => void;
}): JSX.Element {
  const participants = chatParticipants(props.conversation);
  const topLevelMessages = useMemo(() => chatTopLevelMessages(props.conversation), [props.conversation.messages]);
  const threadSummaries = useMemo(() => chatThreadSummaryMap(props.conversation), [props.conversation.messages]);
  const continuedMentionRequestIds = useMemo(() => chatContinuedMentionRequestIds(props.conversation), [props.conversation.messages]);
  const [selectedThreadRootId, setSelectedThreadRootId] = useState<string | undefined>();
  const [threadDrafts, setThreadDrafts] = useState<Record<string, string>>({});
  const [threadWidth, setThreadWidth] = useState(460);
  const [isResizingThread, setIsResizingThread] = useState(false);
  const viewRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const timelineBottomRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const forceStickToBottomRef = useRef(false);
  const previousMessageCountRef = useRef(topLevelMessages.length);
  const latestProgress = props.progress[props.progress.length - 1];
  const thinkingRows = useMemo(() => chatThinkingRows(props.progress), [props.progress]);
  const thinkingSignature = thinkingRows.map((row) => `${row.key}:${row.activity ?? ""}:${row.updatedAt}`).join("|");
  const latestMessage = topLevelMessages[topLevelMessages.length - 1];
  const addDraft = normalizedChatDrafts([props.addParticipantDraft]);
  const addValidation = validateChatParticipantDrafts(
    addDraft,
    props.settings.chatRoleConfigs,
    new Set(participants.map((participant) => participant.handle.toLowerCase()))
  ) ?? validateChatCliAgents(addDraft, props.agents);
  const selectedThreadRoot = selectedThreadRootId
    ? topLevelMessages.find((message) => message.id === selectedThreadRootId)
    : undefined;
  const selectedThreadSummary = selectedThreadRoot ? threadSummaries.get(selectedThreadRoot.id) : undefined;
  const hasThread = Boolean(selectedThreadRoot);

  function updateStickToBottom(): void {
    const timeline = timelineRef.current;
    if (!timeline) {
      return;
    }
    stickToBottomRef.current = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 96;
  }

  function sendDraft(): void {
    forceStickToBottomRef.current = true;
    void props.onSend();
  }

  async function sendThreadDraft(rootMessage: Conversation["messages"][number]): Promise<void> {
    const content = (threadDrafts[rootMessage.id] ?? "").trim();
    if (!content) {
      return;
    }
    const sent = await props.onSendThread(rootMessage, content);
    if (sent) {
      setThreadDrafts((current) => ({ ...current, [rootMessage.id]: "" }));
    }
  }

  function startThreadResize(event: React.PointerEvent<HTMLDivElement>): void {
    const view = viewRef.current;
    if (!view) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsResizingThread(true);
    const rect = view.getBoundingClientRect();
    const minThread = 320;
    const maxThread = Math.max(minThread, Math.min(820, rect.width - 360));

    const move = (moveEvent: PointerEvent): void => {
      const nextWidth = Math.round(rect.right - moveEvent.clientX);
      setThreadWidth(Math.min(maxThread, Math.max(minThread, nextWidth)));
    };
    const stop = (): void => {
      setIsResizingThread(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }

  useEffect(() => {
    setSelectedThreadRootId(undefined);
    setThreadDrafts({});
  }, [props.conversation.id]);

  useEffect(() => {
    if (selectedThreadRootId && !topLevelMessages.some((message) => message.id === selectedThreadRootId)) {
      setSelectedThreadRootId(undefined);
    }
  }, [selectedThreadRootId, topLevelMessages]);

  useLayoutEffect(() => {
    const timeline = timelineRef.current;
    const messageCountChanged = previousMessageCountRef.current !== topLevelMessages.length;
    previousMessageCountRef.current = topLevelMessages.length;
    const shouldFollowBottom = stickToBottomRef.current || forceStickToBottomRef.current || messageCountChanged;
    if (!timeline || !shouldFollowBottom) {
      return;
    }
    const scrollToBottom = (): void => {
      timeline.scrollTo({ top: timeline.scrollHeight });
      timelineBottomRef.current?.scrollIntoView({ block: "end" });
      stickToBottomRef.current = true;
      if (messageCountChanged) {
        forceStickToBottomRef.current = false;
      }
    };
    scrollToBottom();
    window.requestAnimationFrame(scrollToBottom);
    window.setTimeout(scrollToBottom, 50);
  }, [
    topLevelMessages.length,
    latestMessage?.content,
    latestMessage?.status,
    latestProgress?.message,
    thinkingSignature,
    props.draft,
    props.isRunning
  ]);

  useLayoutEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) {
      return;
    }
    const scrollToBottom = (): void => {
      timeline.scrollTo({ top: timeline.scrollHeight });
      timelineBottomRef.current?.scrollIntoView({ block: "end" });
      stickToBottomRef.current = true;
    };
    window.requestAnimationFrame(scrollToBottom);
    window.setTimeout(scrollToBottom, 50);
  }, [topLevelMessages.length]);

  return (
    <div
      className={`chat-view ${hasThread ? "thread-open" : ""} ${isResizingThread ? "resizing-thread" : ""}`}
      data-testid="chat-view"
      ref={viewRef}
      style={{ "--chat-thread-width": `${threadWidth}px` } as React.CSSProperties}
    >
      <div className="chat-main">
        <header className="chat-header">
          <div className="chat-title-block">
            <h2>{props.conversation.title}</h2>
            <span>{props.isRunning ? latestProgress?.message ?? "Running" : props.conversation.repoPath ? "Repo context" : "No repo"}</span>
          </div>
          <div className="chat-header-actions">
            <details className="chat-participant-menu">
              <summary>
                <Users size={17} />
                {participants.length}
              </summary>
              <div className="chat-participant-popover">
                <div className="chat-participant-menu-list">
                  {participants.map((participant) => (
                    <button
                      onClick={() => props.onDraftChange(`${props.draft}${props.draft.endsWith(" ") || !props.draft ? "" : " "}@${participant.handle} `)}
                      key={participant.id}
                    >
                      <Avatar className="mini-avatar" spec={avatarForChatParticipant(participant)} />
                      <strong>@{participant.handle}</strong>
                      <span>{chatRoleLabel(props.settings.chatRoleConfigs, participant)}</span>
                    </button>
                  ))}
                </div>
                <div className="chat-menu-divider" />
                <ChatParticipantDraftRow
                  draft={props.addParticipantDraft}
                  settings={props.settings}
                  agents={props.agents}
                  onChange={props.onAddParticipantDraftChange}
                />
                {addValidation && <div className="inline-error">{addValidation}</div>}
                <Button variant="outline" size="sm" disabled={Boolean(addValidation) || props.isRunning} onClick={props.onAddParticipant}>
                  <Plus size={16} />
                  Add participant
                </Button>
              </div>
            </details>
          </div>
        </header>
        <div className="chat-timeline" ref={timelineRef} onScroll={updateStickToBottom}>
          {topLevelMessages.map((message) => {
            const summary = threadSummaries.get(message.id);
            return (
              <ChatMessageItem
                message={message}
                participants={participants}
                busy={props.isRunning}
                selected={message.id === selectedThreadRoot?.id}
                replyCount={summary?.replies.length ?? 0}
                latestReplyAt={summary?.latestReplyAt}
                hasContinuationReply={continuedMentionRequestIds.has(message.id)}
                onOpenThread={() => setSelectedThreadRootId(message.id)}
                onApproveMentions={props.onApproveMentions}
                onRejectMentions={props.onRejectMentions}
                onRespondToChoice={props.onRespondToChoice}
                key={message.id}
              />
            );
          })}
          {props.isRunning && thinkingRows.map((row) => (
            <ChatThinkingRowItem row={row} key={row.key} />
          ))}
          <div className="chat-timeline-bottom" ref={timelineBottomRef} />
        </div>
        <ChatComposer
          participants={participants}
          settings={props.settings}
          draft={props.draft}
          onDraftChange={props.onDraftChange}
          onSend={sendDraft}
          isRunning={props.isRunning}
          placeholder="Mention participants with @name"
          status={props.isRunning && latestProgress ? <RunStatusLine progress={latestProgress} /> : undefined}
          testId="chat-main-composer"
        />
      </div>
      {selectedThreadRoot && <div className="thread-resizer" role="separator" aria-orientation="vertical" onPointerDown={startThreadResize} />}
      {selectedThreadRoot && (
        <ChatThreadPanel
          rootMessage={selectedThreadRoot}
          replies={selectedThreadSummary?.replies ?? []}
          participants={participants}
          settings={props.settings}
          draft={threadDrafts[selectedThreadRoot.id] ?? ""}
          busy={props.isRunning}
          onDraftChange={(value) => setThreadDrafts((current) => ({ ...current, [selectedThreadRoot.id]: value }))}
          onSend={() => sendThreadDraft(selectedThreadRoot)}
          onClose={() => setSelectedThreadRootId(undefined)}
          onApproveMentions={props.onApproveMentions}
          onRejectMentions={props.onRejectMentions}
          onRespondToChoice={props.onRespondToChoice}
          continuedMentionRequestIds={continuedMentionRequestIds}
        />
      )}
    </div>
  );
}

function ChatComposer(props: {
  participants: ChatParticipant[];
  settings: AppSettings;
  draft: string;
  placeholder: string;
  isRunning: boolean;
  status?: React.ReactNode;
  className?: string;
  rows?: number;
  maxHeight?: number;
  testId?: string;
  onDraftChange: (value: string) => void;
  onSend: () => void | Promise<void>;
}): JSX.Element {
  const [mentionQuery, setMentionQuery] = useState<string | undefined>();
  const [mentionIndex, setMentionIndex] = useState(0);
  const canSend = !props.isRunning && Boolean(props.draft.trim());
  const mentionOptions = mentionQuery === undefined
    ? []
    : props.participants.filter((participant) => participant.handle.toLowerCase().includes(mentionQuery.toLowerCase()));

  function updateDraft(value: string): void {
    props.onDraftChange(value);
    setMentionQuery(activeMentionQuery(value));
    setMentionIndex(0);
  }

  function insertMention(participant: ChatParticipant): void {
    props.onDraftChange(replaceActiveMention(props.draft, participant.handle));
    setMentionQuery(undefined);
    setMentionIndex(0);
  }

  function sendDraft(): void {
    if (canSend) {
      void props.onSend();
    }
  }

  return (
    <div className={`chat-composer ${props.className ?? ""}`} data-testid={props.testId}>
      {props.status && <div className="chat-composer-status">{props.status}</div>}
      <div className="chat-input-wrap">
        {mentionOptions.length > 0 && (
          <div className="mention-menu" role="listbox">
            {mentionOptions.map((participant, index) => (
              <button
                className={index === mentionIndex ? "selected" : ""}
                onMouseDown={(event) => {
                  event.preventDefault();
                  insertMention(participant);
                }}
                role="option"
                aria-selected={index === mentionIndex}
                key={participant.id}
              >
                <Avatar className="mini-avatar" spec={avatarForChatParticipant(participant)} />
                <strong>@{participant.handle}</strong>
                <span>{chatRoleLabel(props.settings.chatRoleConfigs, participant)}</span>
                {index === 0 && <kbd>Enter</kbd>}
              </button>
            ))}
          </div>
        )}
        <ResizableTextarea
          value={props.draft}
          onChange={(event) => updateDraft(event.target.value)}
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
              sendDraft();
            }
          }}
          onBlur={() => window.setTimeout(() => setMentionQuery(undefined), 120)}
          rows={props.rows ?? 2}
          maxHeight={props.maxHeight ?? 260}
          placeholder={props.placeholder}
        />
      </div>
      <Button size="sm" title="Send" disabled={!canSend} onClick={sendDraft}>
        {props.isRunning ? <RefreshCw size={18} className="spin" /> : <SendHorizontal size={18} />}
      </Button>
    </div>
  );
}

function ChatThinkingRowItem({ row }: { row: ChatThinkingRow }): JSX.Element {
  return (
    <div className="chat-thinking-row" aria-live="polite">
      <div className="chat-thinking-primary">
        <strong>{row.participantLabel}</strong>
        <span>Thinking</span>
        <LoadingDot label="In progress" />
      </div>
      {row.activity && <div className="chat-thinking-activity">{row.activity}</div>}
    </div>
  );
}

function ChatMessageItem(props: {
  message: Conversation["messages"][number];
  participants?: ChatParticipant[];
  busy: boolean;
  selected?: boolean;
  inThread?: boolean;
  replyCount?: number;
  latestReplyAt?: string;
  hasContinuationReply?: boolean;
  onOpenThread?: () => void;
  onApproveMentions: (sourceMessageId: string, targetParticipantIds: string[], continueRequester: boolean) => void;
  onRejectMentions: (sourceMessageId: string, targetParticipantIds: string[]) => void;
  onRespondToChoice: (sourceMessageId: string, choiceId: string, response: { selectedOptionId?: string; customAnswer?: string; note?: string }) => void;
}): JSX.Element {
  const { message } = props;
  const [copied, setCopied] = useState(false);
  const author = authorForMessage(message, "chat");
  const participant = message.participantId ? props.participants?.find((item) => item.id === message.participantId) : undefined;
  const pending = (message.metadata?.pendingMentions ?? []).filter((mention) => mention.status === "pending");
  const approved = (message.metadata?.pendingMentions ?? []).filter((mention) => mention.status === "approved");
  const choice = message.metadata?.pendingChoice;
  const allPendingIds = pending.map((mention) => mention.targetParticipantId);
  const displayContent = chatDisplayContent(message, author);
  const showThreadActions = !props.inThread && message.role !== "system" && Boolean(props.onOpenThread);
  const continuationRequested = Boolean(message.metadata?.requesterContinuationRequested);
  const canContinueRequester = message.role === "participant" && continuationRequested && approved.length > 0 && pending.length === 0 && !props.hasContinuationReply;
  const pendingMentionTargetLabel = pending.length === 1 ? `@${pending[0].targetHandle}` : `${pending.length} participants`;
  const approvePendingLabel = continuationRequested ? `Ask ${pendingMentionTargetLabel}, then return to ${author}` : "Approve mentions";
  const replyCount = props.replyCount ?? 0;
  const canCopy = Boolean(displayContent.trim());
  async function copyMessage(): Promise<void> {
    if (!canCopy) {
      return;
    }
    await navigator.clipboard.writeText(displayContent);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }
  const threadActions = showThreadActions ? (
    <>
      {replyCount > 0 && (
        <Button variant="link" size="sm" onClick={props.onOpenThread}>
          <span>{replyCount} {replyCount === 1 ? "reply" : "replies"}</span>
          {props.latestReplyAt && <small>Last reply {formatChatReplyDate(props.latestReplyAt)}</small>}
        </Button>
      )}
      <Button variant="link" size="sm" onClick={props.onOpenThread}>
        Reply
      </Button>
    </>
  ) : null;

  return (
    <>
      <article className={`message chat-message ${choice ? "has-choice" : ""} ${message.role} ${props.selected ? "selected-thread-root" : ""} ${props.inThread ? "in-thread" : ""}`}>
        <Avatar className="message-avatar" spec={avatarForMessage(message, author, participant)} />
        <div className="message-body">
          <IconButton
            className="message-copy-button"
            size="xs"
            icon={copied ? CheckCircle2 : Copy}
            label={copied ? "Copied" : "Copy message"}
            tooltip={copied ? "Copied" : "Copy message"}
            disabled={!canCopy}
            onClick={() => void copyMessage()}
          />
          <div className="message-meta">
            <strong>{author}</strong>
            <span>{new Date(message.createdAt).toLocaleString()}</span>
            {message.status === "error" && <StatusBadge tone="danger">error</StatusBadge>}
            {!props.inThread && message.metadata?.parentMessageId && message.role === "user" && (
              <StatusBadge tone="neutral">reply</StatusBadge>
            )}
          </div>
          <div className="message-content">
            <MarkdownText content={displayContent} />
          </div>
          {approved.length > 0 && (
            <div className="chat-approval-note">
              <span>Approved: {approved.map((mention) => `@${mention.targetHandle}`).join(", ")}</span>
              {canContinueRequester && (
                <Button variant="outline" size="sm" disabled={props.busy} onClick={() => props.onApproveMentions(message.id, [], true)}>
                  <RefreshCw size={15} />
                  Continue {author}
                </Button>
              )}
            </div>
          )}
          {pending.length > 0 && (
            <div className="chat-approval-box">
              <strong>Pending mentions: {pending.map((mention) => `@${mention.targetHandle}`).join(", ")}</strong>
              <div className="chat-approval-actions">
                <Button variant="outline" size="sm" disabled={props.busy} onClick={() => props.onApproveMentions(message.id, allPendingIds, continuationRequested)}>
                  <CheckCircle2 size={16} />
                  {approvePendingLabel}
                </Button>
                {continuationRequested && (
                  <Button variant="outline" size="sm" disabled={props.busy} onClick={() => props.onApproveMentions(message.id, allPendingIds, false)}>
                    Approve mentions
                  </Button>
                )}
                <Button variant="outline" size="sm" disabled={props.busy} onClick={() => props.onRejectMentions(message.id, allPendingIds)}>
                  Reject
                </Button>
                {pending.map((mention) => (
                  <Button
                    variant="outline" size="sm"
                    disabled={props.busy}
                    onClick={() => props.onApproveMentions(message.id, [mention.targetParticipantId], false)}
                    key={mention.targetParticipantId}
                  >
                    Ask @{mention.targetHandle}
                  </Button>
                ))}
              </div>
            </div>
          )}
          {!choice && threadActions}
        </div>
      </article>
      {choice && (
        <div className={`chat-choice-row ${props.inThread ? "in-thread" : ""}`}>
          <span aria-hidden="true" />
          <div className="chat-choice-row-body">
            <ChatChoiceCard
              choice={choice}
              requesterLabel={author}
              busy={props.busy}
              onConfirm={(response) => props.onRespondToChoice(message.id, choice.id, response)}
            />
            {threadActions}
          </div>
        </div>
      )}
    </>
  );
}

function ChatChoiceCard(props: {
  choice: ChatPendingChoice;
  requesterLabel: string;
  busy: boolean;
  onConfirm: (response: { selectedOptionId?: string; customAnswer?: string; note?: string }) => void;
}): JSX.Element {
  const { choice, requesterLabel, busy, onConfirm } = props;
  const [draftSelection, setDraftSelection] = useState(choice.selectedOptionId ?? "");
  const [customAnswer, setCustomAnswer] = useState(choice.customAnswer ?? "");
  const [note, setNote] = useState(choice.note ?? "");
  const isAnswered = choice.status === "selected";
  const selectedOptionId = choice.selectedOptionId ?? draftSelection;
  const isCustomSelected = selectedOptionId === CHAT_CUSTOM_CHOICE_OPTION_ID;
  const selectedOption = choice.options.find((option) => option.id === selectedOptionId);
  const requesterMention = requesterLabel.startsWith("@") ? requesterLabel : requesterLabel === "You" ? "User" : requesterLabel;
  const selectedOverridesRecommendation = isAnswered && Boolean(choice.recommendedOptionId) && selectedOptionId !== choice.recommendedOptionId;
  const receiptTime = formatChatChoiceReceiptTime(choice.selectedAt);
  const canConfirm = !busy && !isAnswered && (isCustomSelected ? Boolean(customAnswer.trim()) : Boolean(selectedOption));
  const selectedLabel = isCustomSelected
    ? customAnswer.trim() || "Write your own answer"
    : selectedOption?.label;
  const trimmedCustomAnswer = customAnswer.trim();
  const trimmedNote = note.trim();
  const showCustomAnswerPanel = isCustomSelected && (!isAnswered || Boolean(trimmedCustomAnswer));
  const showNotePanel = !isCustomSelected && Boolean(selectedOption) && (!isAnswered || Boolean(trimmedNote));

  useEffect(() => {
    setDraftSelection(choice.selectedOptionId ?? "");
    setCustomAnswer(choice.customAnswer ?? "");
    setNote(choice.note ?? "");
  }, [choice.id, choice.selectedOptionId, choice.customAnswer, choice.note]);

  function confirmChoice(): void {
    if (!canConfirm) {
      return;
    }
    if (isCustomSelected) {
      onConfirm({
        selectedOptionId: CHAT_CUSTOM_CHOICE_OPTION_ID,
        customAnswer: customAnswer.trim()
      });
      return;
    }
    if (selectedOption) {
      onConfirm({
        selectedOptionId: selectedOption.id,
        note: note.trim() || undefined
      });
    }
  }

  return (
    <section className={`chat-choice-card ${isAnswered ? "answered" : ""}`} aria-label={choice.title}>
      <div className="chat-choice-head">
        <div className="chat-choice-title-block">
          <span className="chat-choice-kicker">{isAnswered ? "Answered" : "Decision"} · {requesterLabel}</span>
          <h3>{choice.title}</h3>
        </div>
        <span className={`chat-choice-status ${isAnswered ? "answered" : ""}`}>
          {isAnswered && <CheckCircle2 size={14} aria-hidden="true" />}
          {isAnswered ? `Sent${receiptTime ? ` · ${receiptTime}` : ""}` : "Awaiting answer"}
        </span>
      </div>
      <p>{choice.question}</p>
      <div className="chat-choice-options" role="radiogroup" aria-label={choice.question}>
        {choice.options.map((option) => {
          const selected = selectedOptionId === option.id;
          return (
            <label className={`chat-choice-option ${selected ? "selected" : ""} ${isAnswered && !selected ? "collapsed" : ""}`} key={option.id}>
              <input
                type="radio"
                name={choice.id}
                checked={selected}
                disabled={busy || isAnswered}
                onChange={() => setDraftSelection(option.id)}
              />
              <span className="chat-choice-radio" aria-hidden="true" />
              <span className="chat-choice-option-body">
                <span className="chat-choice-option-title">
                  <strong>{option.label}</strong>
                  {isAnswered && selected && selectedOverridesRecommendation && <small className="chat-choice-override-chip">≠ recommendation</small>}
                  {choice.recommendedOptionId === option.id && <small className="chat-choice-recommended-chip">Recommended</small>}
                </span>
                {option.description && (!isAnswered || selected) && <span className="chat-choice-option-description">{option.description}</span>}
              </span>
            </label>
          );
        })}
        <label className={`chat-choice-option custom-answer-option ${isCustomSelected ? "selected" : ""} ${isAnswered && !isCustomSelected ? "collapsed" : ""}`}>
          <input
            type="radio"
            name={choice.id}
            checked={isCustomSelected}
            disabled={busy || isAnswered}
            onChange={() => setDraftSelection(CHAT_CUSTOM_CHOICE_OPTION_ID)}
          />
          <span className="chat-choice-radio" aria-hidden="true" />
          <span className="chat-choice-option-body">
            <span className="chat-choice-option-title">
              <span className="chat-choice-custom-icon" aria-hidden="true">
                <PencilLine size={14} />
              </span>
              <strong>Write your own answer</strong>
              {isAnswered && isCustomSelected && selectedOverridesRecommendation && <small className="chat-choice-override-chip">≠ recommendation</small>}
            </span>
            {(!isAnswered || isCustomSelected) && (
              <span className="chat-choice-option-description">None of the suggestions fit — type your own direction for {requesterMention}.</span>
            )}
          </span>
        </label>
      </div>
      {showCustomAnswerPanel && isAnswered && (
        <div className="chat-choice-text-panel locked">
          <span>
            <strong>Your answer</strong>
            <small>sent to {requesterMention}</small>
          </span>
          <blockquote>{trimmedCustomAnswer}</blockquote>
        </div>
      )}
      {showCustomAnswerPanel && !isAnswered && (
        <label className="chat-choice-text-panel">
          <span>
            <strong>Your answer</strong>
            <small>required · sent verbatim to {requesterMention}</small>
          </span>
          <Textarea
            value={customAnswer}
            onChange={(event) => setCustomAnswer(event.target.value)}
            placeholder={'e.g. "Use session cookies for web, but issue short-lived JWTs to native clients"'}
            rows={3}
            disabled={busy || isAnswered}
          />
        </label>
      )}
      {showNotePanel && isAnswered && (
        <div className="chat-choice-text-panel locked">
          <span>
            <strong>Your note</strong>
            <small>sent with your pick</small>
          </span>
          <blockquote>{trimmedNote}</blockquote>
        </div>
      )}
      {showNotePanel && !isAnswered && (
        <label className="chat-choice-text-panel">
          <span>
            <strong>Add a note</strong>
            <small>optional · {requesterMention} will see it alongside your pick</small>
          </span>
          <Textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={`Constraints, caveats, or follow-up questions for ${requesterMention}...`}
            rows={2}
            disabled={busy || isAnswered}
          />
        </label>
      )}
      {!isAnswered && (
        <div className="chat-choice-actions">
          {isCustomSelected && !customAnswer.trim() ? (
            <span>Type your answer to enable send.</span>
          ) : selectedLabel ? (
            <span>Selected: <strong>{selectedLabel}</strong></span>
          ) : (
            <span>Select one option to continue.</span>
          )}
          <Button size="sm" disabled={!canConfirm} onClick={confirmChoice}>
            {`Send to ${requesterMention}`}
          </Button>
        </div>
      )}
    </section>
  );
}

function ChatThreadPanel(props: {
  rootMessage: Conversation["messages"][number];
  replies: Conversation["messages"][number][];
  participants: ChatParticipant[];
  settings: AppSettings;
  draft: string;
  busy: boolean;
  onDraftChange: (value: string) => void;
  onSend: () => void | Promise<void>;
  onClose: () => void;
  onApproveMentions: (sourceMessageId: string, targetParticipantIds: string[], continueRequester: boolean) => void;
  onRejectMentions: (sourceMessageId: string, targetParticipantIds: string[]) => void;
  onRespondToChoice: (sourceMessageId: string, choiceId: string, response: { selectedOptionId?: string; customAnswer?: string; note?: string }) => void;
  continuedMentionRequestIds: Set<string>;
}): JSX.Element {
  const rootAuthor = authorForMessage(props.rootMessage, "chat");
  return (
    <section className="chat-thread-panel" aria-label="Chat thread" data-testid="chat-thread-panel">
      <header className="thread-panel-head chat-thread-head">
        <div>
          <h2>Thread</h2>
          <span>{rootAuthor}</span>
        </div>
        <div className="thread-panel-actions">
          <IconButton size="sm" icon={X} label="Close thread" tooltip="Close thread" onClick={props.onClose} />
        </div>
      </header>
      <div className="chat-thread-body">
        <ChatMessageItem
          message={props.rootMessage}
          participants={props.participants}
          busy={props.busy}
          inThread
          hasContinuationReply={props.continuedMentionRequestIds.has(props.rootMessage.id)}
          onApproveMentions={props.onApproveMentions}
          onRejectMentions={props.onRejectMentions}
          onRespondToChoice={props.onRespondToChoice}
        />
        {props.replies.length > 0 && (
          <div className="chat-thread-replies">
            {props.replies.map((message) => (
              <ChatMessageItem
                message={message}
                participants={props.participants}
                busy={props.busy}
                inThread
                hasContinuationReply={props.continuedMentionRequestIds.has(message.id)}
                onApproveMentions={props.onApproveMentions}
                onRejectMentions={props.onRejectMentions}
                onRespondToChoice={props.onRespondToChoice}
                key={message.id}
              />
            ))}
          </div>
        )}
      </div>
      <ChatComposer
        className="chat-thread-composer"
        participants={props.participants}
        settings={props.settings}
        draft={props.draft}
        onDraftChange={props.onDraftChange}
        onSend={props.onSend}
        isRunning={props.busy}
        placeholder="Reply..."
        rows={3}
        maxHeight={180}
        testId="chat-thread-composer"
      />
    </section>
  );
}

type TimelineItem =
  | { id: string; type: "message"; createdAt: string; message: Conversation["messages"][number] }
  | { id: string; type: "finding"; createdAt: string; finding: Finding }
  | { id: string; type: "decision"; createdAt: string; decision: PlanDecisionRequest };

function SlackView(props: {
  conversation?: Conversation;
  progress: ReviewProgress[];
  kind: ConversationKind;
  isRunning: boolean;
  selectedThreadId?: string;
  focusedThreadId?: string;
  onSelectThread: (id: string | undefined) => void;
  onFocusThread: (id: string) => void;
  onExitFocus: () => void;
  onCloseThread: () => void;
  pendingDecisions: PlanDecisionRequest[];
  decisionReplies: PlanDecisionReply[];
  decisionAnswers: Record<string, string>;
  decisionResolutions: Record<string, boolean>;
  clarificationDrafts: Record<string, string>;
  planItemReviewDrafts: Record<string, string>;
  planCorrectionDraft: string;
  canComposePlan: boolean;
  reviewedPlanItemCount: number;
  reviewablePlanItemCount: number;
  canRecoverPlan: boolean;
  onDecisionAnswer: (decisionId: string, optionId: string) => void;
  onResolveDecision: (decisionId: string) => void;
  onClarificationDraftChange: (decisionId: string, value: string) => void;
  onAskClarification: (decisionId: string) => void;
  onPlanItemReviewDraftChange: (findingId: string, value: string) => void;
  onConfirmPlanItem: (findingId: string) => void;
  onCommentPlanItem: (findingId: string) => void;
  onPlanCorrectionDraftChange: (value: string) => void;
  onContinue: () => void;
  onComposePlan: () => void;
  onRetryFinalPlan: () => void;
  onRecoverPlan: () => void;
  onRevisePlan: () => void;
}): JSX.Element {
  const {
    conversation,
    progress,
    kind,
    isRunning,
    selectedThreadId,
    focusedThreadId,
    onSelectThread,
    onFocusThread,
    onExitFocus,
    onCloseThread,
    pendingDecisions,
    decisionReplies,
    decisionAnswers,
    decisionResolutions,
    clarificationDrafts,
    planItemReviewDrafts,
    planCorrectionDraft,
    canComposePlan,
    reviewedPlanItemCount,
    reviewablePlanItemCount,
    canRecoverPlan,
    onDecisionAnswer,
    onResolveDecision,
    onClarificationDraftChange,
    onAskClarification,
    onPlanItemReviewDraftChange,
    onConfirmPlanItem,
    onCommentPlanItem,
    onPlanCorrectionDraftChange,
    onContinue,
    onComposePlan,
    onRetryFinalPlan,
    onRecoverPlan,
    onRevisePlan
  } = props;
  const [threadWidth, setThreadWidth] = useState(460);
  const [isResizingThread, setIsResizingThread] = useState(false);
  const viewRef = useRef<HTMLDivElement>(null);

  if (!conversation) {
    return <EmptyState title="No conversation selected" body="Start a new review or choose a previous conversation." />;
  }

  const showLiveProgress = isRunning && (conversation.metadata.running === true || progress.length > 0);
  const latestLiveProgress = showLiveProgress ? progress[progress.length - 1] : undefined;
  const itemReviews = planItemReviews(conversation);
  const isReviewingPlanItems = pendingPlanItemReview(conversation);
  const reviewablePlanItems = requiredPlanItemReviewFindings(conversation);
  const planActionItemIds = new Set(reviewablePlanItems.map((finding) => finding.id));
  const pendingReviewPlanItemIds = new Set(
    reviewablePlanItems.filter((finding) => !planItemReviewForFinding(finding, itemReviews)).map((finding) => finding.id)
  );
  const visibleFindings = timelineFindings(conversation);
  const visibleDecisions = visiblePlanDecisionRequests(conversation);
  const pendingDecisionIds = new Set(pendingDecisions.map((decision) => decision.id));
  const messageItems: TimelineItem[] = conversation.messages
    .filter((message) => (kind === "implementation-plan" || message.role !== "summary") && !message.progressPhase && !isHiddenImplementationPlanInternalMessage(message, kind))
    .map((message) => ({
      id: message.id,
      type: "message",
      createdAt: message.createdAt,
      message
    }));
  const findingItems: TimelineItem[] = visibleFindings.map((finding) => ({
    id: finding.id,
    type: "finding",
    createdAt: finding.createdAt ?? conversation.updatedAt,
    finding
  }));
  const decisionItems: TimelineItem[] = visibleDecisions.map((decision) => ({
    id: decision.id,
    type: "decision",
    createdAt: decision.createdAt,
    decision
  }));
  const items = [...messageItems, ...decisionItems, ...findingItems].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  const selectedFinding = visibleFindings.find((finding) => finding.id === selectedThreadId);
  const selectedDecision = visibleDecisions.find((decision) => decision.id === selectedThreadId);
  const selectedDecisionIsPending = Boolean(selectedDecision && pendingDecisionIds.has(selectedDecision.id));
  const selectedFindingReview = selectedFinding ? planItemReviewForFinding(selectedFinding, itemReviews) : undefined;
  const selectedFindingIsPlanActionItem = Boolean(selectedFinding && planActionItemIds.has(selectedFinding.id));
  const selectedFindingNeedsReview = Boolean(selectedFinding && pendingReviewPlanItemIds.has(selectedFinding.id));
  const savedDecisionAnswers = implementationPlanAnswers(conversation);
  const selectedDecisionAnswer = selectedDecision ? decisionAnswerForDecision(selectedDecision, savedDecisionAnswers) : undefined;
  const readyDecisionCount = pendingDecisions.filter((decision) =>
    decisionThreadIsReady(decision, decisionAnswers, decisionResolutions, savedDecisionAnswers)
  ).length;
  const hasAnyDecisionInput = readyDecisionCount > 0;
  const pendingPlanReviewCount = Math.max(0, reviewablePlanItemCount - reviewedPlanItemCount);
  const decisionActionTitle =
    readyDecisionCount === 0
      ? "No decisions ready"
      : readyDecisionCount === pendingDecisions.length
        ? "All decisions ready"
        : "Decisions ready";
  const isThreadFocused = Boolean(focusedThreadId && (selectedDecision || selectedFinding));
  const hasThread = Boolean(selectedDecision || selectedFinding);
  const hasFinalPlan = hasFinalImplementationPlan(conversation);
  const canRetryFinalPlan = kind === "implementation-plan" && !isReviewingPlanItems && conversation.findings.some((finding) => finding.status === "Confirmed") && hasFallbackFinalPlan(conversation);
  const showPlanFollowupComposer = kind === "implementation-plan" && !isReviewingPlanItems && pendingDecisions.length === 0;
  const planFollowupDisabled = isRunning || !hasFinalPlan;
  const planFollowupPlaceholder = isRunning
    ? "Wait for the current plan run to finish"
    : hasFinalPlan
      ? "Ask for follow-up changes"
      : canRecoverPlan
        ? "Resume the plan before follow-up changes"
        : "Final plan needed before follow-up changes";

  function startThreadResize(event: React.PointerEvent<HTMLDivElement>): void {
    const view = viewRef.current;
    if (!view) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsResizingThread(true);
    const rect = view.getBoundingClientRect();
    const minThread = 320;
    const maxThread = Math.max(minThread, Math.min(820, rect.width - 360));

    const move = (moveEvent: PointerEvent): void => {
      const nextWidth = Math.round(rect.right - moveEvent.clientX);
      setThreadWidth(Math.min(maxThread, Math.max(minThread, nextWidth)));
    };
    const stop = (): void => {
      setIsResizingThread(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }

  return (
    <div
      className={`slack-view ${hasThread ? "thread-open" : ""} ${isThreadFocused ? "thread-focused" : ""} ${isResizingThread ? "resizing-thread" : ""}`}
      ref={viewRef}
      style={{ "--thread-width": `${threadWidth}px` } as React.CSSProperties}
    >
      {!isThreadFocused && (
        <section className="slack-timeline" aria-label="Consensus timeline">
          <div className="view-heading">
            <h2>{kind === "code-review" ? "Review Timeline" : kind === "implementation-plan" ? "Plan Timeline" : "Consensus Timeline"}</h2>
            <div className="view-heading-actions">
              <span>
                {showLiveProgress
                  ? liveProgressLabel(progress)
                  : pendingDecisions.length
                    ? `${pendingDecisions.length} decisions`
                    : isReviewingPlanItems
                      ? pendingPlanReviewCount > 0
                        ? `${pendingPlanReviewCount} action${pendingPlanReviewCount === 1 ? "" : "s"} needed`
                        : "No reviews needed"
                    : kind === "implementation-plan"
                      ? canRecoverPlan
                        ? "Interrupted"
                        : hasFinalPlan
                        ? "Final plan"
                        : "No actions needed"
                      : `${conversation.findings.length} points`}
              </span>
              {canRecoverPlan && (
                <Button size="sm" disabled={isRunning} onClick={onRecoverPlan}>
                  {isRunning ? <RefreshCw size={17} className="spin" /> : <Play size={17} />}
                  {isRunning ? "Resuming..." : "Resume plan"}
                </Button>
              )}
              {canRetryFinalPlan && (
                <Button size="sm" disabled={isRunning} onClick={onRetryFinalPlan}>
                  {isRunning ? <RefreshCw size={17} className="spin" /> : <RefreshCw size={17} />}
                  {isRunning ? "Retrying..." : "Retry final plan"}
                </Button>
              )}
              {pendingDecisions.length === 0 && isReviewingPlanItems && (
                <Button size="sm" disabled={isRunning || !canComposePlan} onClick={onComposePlan}>
                  {isRunning ? <RefreshCw size={17} className="spin" /> : <Play size={17} />}
                  {isRunning ? "Composing..." : "Compose final plan"}
                </Button>
              )}
            </div>
          </div>
          {items.map((item) =>
            item.type === "message" ? (
              <TimelineMessage message={item.message} kind={kind} key={item.id} />
            ) : item.type === "finding" ? (
              <PointTimelineMessage
                finding={item.finding}
                kind={kind}
                selected={item.finding.id === selectedThreadId}
                reviewRequired={planActionItemIds.has(item.finding.id)}
                review={planItemReviewForFinding(item.finding, itemReviews)}
                onSelect={() => onSelectThread(item.finding.id)}
                key={item.id}
              />
            ) : (
              <DecisionTimelineMessage
                decision={item.decision}
                selected={item.decision.id === selectedThreadId}
                pending={pendingDecisionIds.has(item.decision.id)}
                ready={decisionThreadIsReady(item.decision, decisionAnswers, decisionResolutions, savedDecisionAnswers)}
                replyCount={decisionReplies.filter((reply) => reply.decisionId === item.decision.id).length}
                onSelect={() => onSelectThread(item.decision.id)}
                key={item.id}
              />
            )
          )}
        </section>
      )}
      {hasThread && !isThreadFocused && <div className="thread-resizer" role="separator" aria-orientation="vertical" onPointerDown={startThreadResize} />}
      {hasThread && (
        <section className="slack-thread-panel" aria-label="Point thread">
          {selectedDecision ? (
            <DecisionThread
              decision={selectedDecision}
              replies={decisionReplies.filter((reply) => reply.decisionId === selectedDecision.id)}
              selectedOptionId={decisionAnswers[selectedDecision.id] ?? selectedDecisionAnswer?.selectedOptionId}
              resolved={Boolean(decisionResolutions[selectedDecision.id])}
              readOnly={!selectedDecisionIsPending}
              savedAnswer={selectedDecisionAnswer}
              clarificationDraft={clarificationDrafts[selectedDecision.id] ?? ""}
              typingLabels={decisionTypingLabels(selectedDecision, progress, isRunning)}
              busy={isRunning}
              focused={isThreadFocused}
              onFocus={() => onFocusThread(selectedDecision.id)}
              onExitFocus={onExitFocus}
              onClose={onCloseThread}
              onSelectOption={(optionId) => onDecisionAnswer(selectedDecision.id, optionId)}
              onResolve={() => onResolveDecision(selectedDecision.id)}
              onDraftChange={(value) => onClarificationDraftChange(selectedDecision.id, value)}
              onAskClarification={() => onAskClarification(selectedDecision.id)}
            />
          ) : selectedFinding ? (
            <PointThread
              finding={selectedFinding}
              kind={kind}
              focused={isThreadFocused}
              reviewRequired={selectedFindingIsPlanActionItem}
              reviewReadOnly={!selectedFindingNeedsReview}
              review={selectedFindingReview}
              reviewDraft={planItemReviewDrafts[selectedFinding.id] ?? ""}
              busy={isRunning}
              onFocus={() => onFocusThread(selectedFinding.id)}
              onExitFocus={onExitFocus}
              onClose={onCloseThread}
              onConfirmReview={() => onConfirmPlanItem(selectedFinding.id)}
              onReviewDraftChange={(value) => onPlanItemReviewDraftChange(selectedFinding.id, value)}
              onSubmitReviewComment={() => onCommentPlanItem(selectedFinding.id)}
            />
          ) : (
            <div className="thread-empty-state">
              <MessageSquare size={24} />
              <h2>
                {pendingDecisions.length
                  ? "Decision thread"
                  : kind === "code-review"
                    ? "Finding thread"
                    : kind === "implementation-plan"
                      ? "Plan item thread"
                      : "Point thread"}
              </h2>
              <p>No point selected.</p>
            </div>
          )}
        </section>
      )}
      {(showLiveProgress || pendingDecisions.length > 0 || showPlanFollowupComposer) && (
        <div className={`slack-action-bar ${showPlanFollowupComposer ? "with-composer" : ""}`} role="region" aria-label="Run status and actions">
          {showLiveProgress && !showPlanFollowupComposer ? <RunStatusLine progress={latestLiveProgress} /> : pendingDecisions.length > 0 ? <span className="slack-action-spacer" /> : null}
          {pendingDecisions.length > 0 && (
            <div className="decision-action-bar" aria-label="Decision actions">
              <div className="decision-action-status" aria-live="polite">
                <span>
                  {readyDecisionCount}/{pendingDecisions.length} ready
                </span>
                <strong>{decisionActionTitle}</strong>
              </div>
              <Button size="sm" disabled={isRunning || !hasAnyDecisionInput} onClick={onContinue}>
                {isRunning ? <RefreshCw size={17} className="spin" /> : <Play size={17} />}
                {isRunning ? "Continuing..." : "Continue plan"}
              </Button>
            </div>
          )}
          {showPlanFollowupComposer && (
            <PlanCorrectionComposer
              draft={planCorrectionDraft}
              busy={isRunning}
              disabled={planFollowupDisabled}
              placeholder={planFollowupPlaceholder}
              status={showLiveProgress ? <RunStatusLine progress={latestLiveProgress} /> : undefined}
              onDraftChange={onPlanCorrectionDraftChange}
              onSubmit={onRevisePlan}
            />
          )}
        </div>
      )}
    </div>
  );
}

function TimelineMessage({ message, kind }: { message: Conversation["messages"][number]; kind: ConversationKind }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const author = authorForMessage(message, kind);
  const isLiveProgress = Boolean(message.progressPhase && message.status === "pending");
  const isFinalPlan = kind === "implementation-plan" && message.role === "summary";
  const display = displayMessageContent(message, kind);
  const canCopy = Boolean(display.content.trim());

  async function copyMessage(): Promise<void> {
    if (!canCopy) {
      return;
    }
    await navigator.clipboard.writeText(display.content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  return (
    <article
      className={`message ${message.role} ${isLiveProgress ? "progress-active" : ""} ${isFinalPlan ? "final-plan-message" : ""}`}
      data-final-plan={isFinalPlan ? "true" : undefined}
    >
      <Avatar className="message-avatar" spec={avatarForMessage(message, author)} />
      <div className="message-body">
        <IconButton
          className="message-copy-button"
          size="xs"
          icon={copied ? CheckCircle2 : Copy}
          label={copied ? "Copied" : "Copy markdown"}
          tooltip={copied ? "Copied" : "Copy markdown"}
          disabled={!canCopy}
          data-testid={isFinalPlan ? "final-plan-copy-button" : undefined}
          onClick={() => void copyMessage()}
        />
        <div className="message-meta">
          <strong>{author}</strong>
          {isFinalPlan && (
            <StatusBadge tone="success" icon={CheckCircle2} uppercase>
              Final plan
            </StatusBadge>
          )}
          <span>{new Date(message.createdAt).toLocaleString()}</span>
          {message.progressPhase && (
            <StatusBadge tone="neutral">{message.progressPhase}</StatusBadge>
          )}
          {isLiveProgress && <LoadingDot label="In progress" />}
          {message.status === "error" && <StatusBadge tone="danger">error</StatusBadge>}
        </div>
        <div className="message-content">{display.markdown ? <MarkdownText content={display.content} /> : <pre>{display.content}</pre>}</div>
      </div>
    </article>
  );
}

function RunStatusLine({ progress }: { progress?: ReviewProgress }): JSX.Element {
  return (
    <div className="run-status-line" aria-live="polite">
      <span className="run-status-text">{progress?.message ?? "Thinking"}</span>
      <LoadingDot label="In progress" />
    </div>
  );
}

function PointTimelineMessage(props: { finding: Finding; kind: ConversationKind; selected: boolean; reviewRequired?: boolean; review?: PlanItemReview; onSelect: () => void }): JSX.Element {
  const { finding, kind, selected, reviewRequired, review, onSelect } = props;
  const ownerLabel = kind === "implementation-plan" ? "Planner" : "Arbiter";
  const metaLabel = kind === "implementation-plan" ? "Plan item extracted" : "Point extracted";
  return (
    <article
      className={`message system point-message ${selected ? "selected" : ""}`}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <Avatar className="message-avatar" spec={ARBITER_AVATAR} />
      <div className="message-body">
        <div className="message-meta">
          <strong>{ownerLabel}</strong>
          <span>{metaLabel}</span>
          <PointStatusBadge finding={finding} />
          {reviewRequired && <PlanItemReviewBadge review={review} />}
          <SeverityBadge severity={finding.severity} />
        </div>
        <h3>{finding.title}</h3>
        <p>{finding.claim || finding.description}</p>
        <small>{finding.rounds.length} thread {finding.rounds.length === 1 ? "reply" : "replies"}</small>
      </div>
    </article>
  );
}

function DecisionTimelineMessage(props: {
  decision: PlanDecisionRequest;
  selected: boolean;
  pending: boolean;
  ready: boolean;
  replyCount: number;
  onSelect: () => void;
}): JSX.Element {
  const { decision, selected, pending, ready, replyCount, onSelect } = props;
  const author = sourceLabelForDecision(decision);
  const statusLabel = pending ? (ready ? "ready" : "pending") : "answered";
  return (
    <article
      className={`message system point-message decision-message ${selected ? "selected" : ""}`}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <Avatar className="message-avatar" spec={avatarForParticipant(author, decision.sourceParticipantIds?.[0])} />
      <div className="message-body">
        <div className="message-meta">
          <strong>{author}</strong>
          <span>{pending ? "Decision needed" : "Decision answered"}</span>
          <StatusBadge tone={ready || !pending ? "success" : "neutral"}>{statusLabel}</StatusBadge>
        </div>
        <h3>{decision.title}</h3>
        <p>{decision.question}</p>
        <small>{replyCount} thread {replyCount === 1 ? "reply" : "replies"}</small>
      </div>
    </article>
  );
}

function PointThread(props: {
  finding: Finding;
  kind: ConversationKind;
  focused: boolean;
  reviewRequired?: boolean;
  reviewReadOnly?: boolean;
  review?: PlanItemReview;
  reviewDraft?: string;
  busy?: boolean;
  onFocus: () => void;
  onExitFocus: () => void;
  onClose: () => void;
  onConfirmReview?: () => void;
  onReviewDraftChange?: (value: string) => void;
  onSubmitReviewComment?: () => void;
}): JSX.Element {
  const {
    finding,
    kind,
    focused,
    reviewRequired,
    reviewReadOnly = false,
    review,
    reviewDraft = "",
    busy = false,
    onFocus,
    onExitFocus,
    onClose,
    onConfirmReview,
    onReviewDraftChange,
    onSubmitReviewComment
  } = props;
  const replies = pointThreadReplies(finding);
  const hasPlanSources = Boolean(finding.sourceItems?.length);
  const ownerLabel = kind === "implementation-plan" ? "Planner" : "Arbiter";

  return (
    <div className="point-thread">
      <div className="thread-panel-head">
        <div>
          <span>Thread</span>
          <h2>{finding.title}</h2>
        </div>
        <div className="thread-panel-actions">
          <PointStatusBadge finding={finding} />
          {reviewRequired && <PlanItemReviewBadge review={review} />}
          <IconButton
            size="sm"
            icon={focused ? Columns2 : Maximize2}
            label={focused ? "Show timeline" : "Expand thread"}
            tooltip={focused ? "Show timeline" : "Expand thread"}
            onClick={focused ? onExitFocus : onFocus}
          />
          <IconButton size="sm" icon={X} label="Close thread" tooltip="Close thread" onClick={onClose} />
        </div>
      </div>

      <ThreadMessage
        avatar={ARBITER_AVATAR}
        author={ownerLabel}
        meta={hasPlanSources ? "Canonical plan item" : "Parent point"}
        createdAt={finding.createdAt}
        content={hasPlanSources ? canonicalPlanItemContent(finding) : pointSourceContent(finding)}
        title={finding.title}
        badges={
          <>
            <PointStatusBadge finding={finding} />
            {reviewRequired && <PlanItemReviewBadge review={review} />}
            <SeverityBadge severity={finding.severity} />
          </>
        }
      />

      {hasPlanSources && <PlanSourceSupport finding={finding} />}

      {replies.length > 0 && (
        <div className="thread-replies">
          {replies.map((reply) => (
            <ThreadMessage
              avatar={avatarForParticipant(reply.author)}
              author={reply.author}
              meta={reply.meta}
              createdAt={reply.createdAt}
              content={reply.content}
              key={reply.id}
            />
          ))}
        </div>
      )}

      {reviewRequired && (
        <PlanItemReviewComposer
          review={review}
          readOnly={reviewReadOnly}
          draft={reviewDraft}
          busy={busy}
          onConfirm={onConfirmReview}
          onDraftChange={onReviewDraftChange}
          onSubmitComment={onSubmitReviewComment}
        />
      )}
    </div>
  );
}

function PlanSourceSupport({ finding }: { finding: Finding }): JSX.Element | null {
  const sourceItems = finding.sourceItems ?? [];
  if (sourceItems.length === 0) {
    return null;
  }
  const hasRawPlans = sourceItems.some((item) => Boolean(item.rawContent?.trim()));

  return (
    <section className="plan-source-support">
      <div className="plan-source-support-head">
        <span>Agent support</span>
        <strong>{sourceItems.length} source{sourceItems.length === 1 ? "" : "s"}</strong>
      </div>
      <div className="plan-source-support-list">
        {sourceItems.map((item, index) => (
          <div className="plan-source-support-row" key={`${item.participantId}-${index}`}>
            <Avatar className="thread-avatar support-avatar" spec={avatarForParticipant(item.participantLabel, item.participantId)} />
            <div>
              <strong>{item.participantLabel}</strong>
              <span>Supported this canonical item</span>
            </div>
          </div>
        ))}
      </div>
      <details className="plan-source-details">
        <summary>{hasRawPlans ? "Original participant plans" : "Original participant plan items"}</summary>
        <div className="plan-source-detail-list">
          {sourceItems.map((item, index) => (
            <article className="plan-source-detail-card" key={`${item.participantId}-detail-${index}`}>
              <div className="message-meta">
                <strong>{item.participantLabel}</strong>
                <span>{item.rawContent?.trim() ? "Initial plan" : "Initial plan item"}</span>
              </div>
              <MarkdownText content={sourceItemContent(item)} />
            </article>
          ))}
        </div>
      </details>
    </section>
  );
}

function PlanItemReviewComposer(props: {
  review?: PlanItemReview;
  readOnly?: boolean;
  draft: string;
  busy: boolean;
  onConfirm?: () => void;
  onDraftChange?: (value: string) => void;
  onSubmitComment?: () => void;
}): JSX.Element {
  const { review, readOnly = false, draft, busy, onConfirm, onDraftChange, onSubmitComment } = props;
  if (readOnly) {
    return review ? (
      <div className="plan-item-review-box">
        <ThreadMessage
          avatar={USER_AVATAR}
          author="You"
          meta={review.status === "commented" ? "Item comment" : "Item confirmation"}
          createdAt={review.updatedAt}
          content={review.status === "commented" ? review.comment ?? "" : "Confirmed as-is."}
        />
      </div>
    ) : <div className="plan-item-review-box" />;
  }
  return (
    <div className="plan-item-review-box">
      {review && (
        <ThreadMessage
          avatar={USER_AVATAR}
          author="You"
          meta={review.status === "commented" ? "Item comment" : "Item confirmation"}
          createdAt={review.updatedAt}
          content={review.status === "commented" ? review.comment ?? "" : "Confirmed as-is."}
        />
      )}
      <div className="decision-compose plan-item-review-compose">
        <ResizableTextarea
          value={draft}
          onChange={(event) => onDraftChange?.(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (!busy && draft.trim()) {
                onSubmitComment?.();
              }
            }
          }}
          rows={3}
          maxHeight={220}
          placeholder="Comment before final plan synthesis"
          disabled={busy}
        />
        <div className="plan-item-review-actions">
          <Button variant="outline" size="sm" disabled={busy || !draft.trim()} onClick={onSubmitComment}>
            <MessageSquare size={16} />
            Comment
          </Button>
          <Button variant="outline" size="sm" disabled={busy || review?.status === "confirmed"} onClick={onConfirm}>
            <CheckCircle2 size={16} />
            Confirm
          </Button>
        </div>
      </div>
    </div>
  );
}

function PlanCorrectionComposer(props: {
  draft: string;
  busy: boolean;
  disabled?: boolean;
  placeholder?: string;
  status?: React.ReactNode;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
}): JSX.Element {
  const { draft, busy, disabled = false, placeholder = "Ask for follow-up changes", status, onDraftChange, onSubmit } = props;
  const canSubmit = !busy && !disabled && Boolean(draft.trim());
  const disabledTitle = disabled && !busy ? placeholder : "Send correction";
  return (
    <div className={`plan-correction-composer ${busy ? "is-running" : ""}`} data-testid="plan-followup-composer">
      {status && <div className="plan-correction-status">{status}</div>}
      <div className="plan-correction-input-row">
        <ResizableTextarea
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (canSubmit) {
                onSubmit();
              }
            }
          }}
          rows={2}
          maxHeight={220}
          placeholder={placeholder}
          disabled={busy || disabled}
        />
        <Button size="sm" title={disabledTitle} disabled={!canSubmit} onClick={onSubmit}>
          {busy ? <RefreshCw size={18} className="spin" /> : <SendHorizontal size={18} />}
        </Button>
      </div>
    </div>
  );
}

function DecisionThread(props: {
  decision: PlanDecisionRequest;
  replies: PlanDecisionReply[];
  selectedOptionId?: string;
  resolved: boolean;
  readOnly: boolean;
  savedAnswer?: PlanDecisionAnswer;
  clarificationDraft: string;
  typingLabels: string[];
  busy: boolean;
  focused: boolean;
  onFocus: () => void;
  onExitFocus: () => void;
  onClose: () => void;
  onSelectOption: (optionId: string) => void;
  onResolve: () => void;
  onDraftChange: (value: string) => void;
  onAskClarification: () => void;
}): JSX.Element {
  const {
    decision,
    replies,
    selectedOptionId,
    resolved,
    readOnly,
    savedAnswer,
    clarificationDraft,
    typingLabels,
    busy,
    focused,
    onFocus,
    onExitFocus,
    onClose,
    onSelectOption,
    onResolve,
    onDraftChange,
    onAskClarification
  } = props;
  const isAsking = busy && replies.some((reply) => reply.id.startsWith("pending:"));
  const hasThreadContext = decisionThreadIsReady(
    decision,
    selectedOptionId ? { [decision.id]: selectedOptionId } : {},
    resolved ? { [decision.id]: true } : {},
    savedAnswer ? [savedAnswer] : []
  );
  const canResolve = !hasThreadContext && decisionThreadHasUserReply(decision, replies);
  const decisionAuthor = sourceLabelForDecision(decision);
  const statusLabel = readOnly ? "answered" : hasThreadContext ? "ready" : "pending";

  return (
    <div className="point-thread decision-thread">
      <div className="thread-panel-head">
        <div>
          <span>Decision</span>
          <h2>{decision.title}</h2>
        </div>
        <div className="thread-panel-actions">
          <StatusBadge tone={hasThreadContext || readOnly ? "success" : "neutral"}>{statusLabel}</StatusBadge>
          <IconButton
            size="sm"
            icon={focused ? Columns2 : Maximize2}
            label={focused ? "Show timeline" : "Expand thread"}
            tooltip={focused ? "Show timeline" : "Expand thread"}
            onClick={focused ? onExitFocus : onFocus}
          />
          <IconButton size="sm" icon={X} label="Close thread" tooltip="Close thread" onClick={onClose} />
        </div>
      </div>

      <ThreadMessage
        avatar={avatarForParticipant(decisionAuthor, decision.sourceParticipantIds?.[0])}
        author={decisionAuthor}
        meta="Decision request"
        createdAt={decision.createdAt}
        title={decision.question}
        content={decision.impact}
      />

      {decision.options.length > 0 && (
        <div className="decision-options thread-decision-options">
          {decision.options.map((option) => (
            <label className={`decision-option ${selectedOptionId === option.id ? "selected" : ""}`} key={option.id}>
              <input
                type="radio"
                name={decision.id}
                checked={selectedOptionId === option.id}
                disabled={busy || readOnly}
                onChange={() => onSelectOption(option.id)}
              />
              <span className="decision-option-body">
                <span>{option.label}</span>
                {decision.recommendedOptionId === option.id && <small>Recommended</small>}
              </span>
            </label>
          ))}
        </div>
      )}

      <div className="thread-replies">
        {readOnly && savedAnswer && (
          <ThreadMessage
            avatar={savedAnswer.answerSource === "automatic" ? ARBITER_AVATAR : USER_AVATAR}
            author={savedAnswer.answerSource === "automatic" ? "Planner" : "You"}
            meta={savedAnswer.answerSource === "automatic" ? "Automatic answer" : "Answer"}
            content={savedAnswer.answer}
          />
        )}
        {replies.map((reply) => (
          <ThreadMessage
            avatar={reply.role === "user" ? USER_AVATAR : avatarForParticipant(reply.participantLabel ?? reply.role, reply.participantId)}
            author={reply.role === "user" ? "You" : reply.participantLabel ?? "Participant"}
            meta={reply.id.startsWith("pending:") ? "Message sent" : reply.status === "error" ? "Reply error" : reply.answerSource === "automatic" ? "automatic" : reply.role === "user" ? "Message" : "Reply"}
            createdAt={reply.createdAt}
            content={reply.content}
            key={reply.id}
          />
        ))}
        {isAsking && (
          <TypingIndicator labels={typingLabels} />
        )}
      </div>

      {!readOnly && (
        <div className="decision-compose">
          <ResizableTextarea
            value={clarificationDraft}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (!busy && clarificationDraft.trim()) {
                  onAskClarification();
                }
              }
            }}
            rows={3}
            maxHeight={240}
            placeholder="Send a message in this thread"
            disabled={busy}
          />
          <div className="decision-compose-actions">
            <Button variant="outline" size="sm" disabled={busy || !clarificationDraft.trim()} onClick={onAskClarification}>
              {isAsking ? <RefreshCw size={16} className="spin" /> : <MessageSquare size={16} />}
              {isAsking ? "Sending..." : "Send"}
            </Button>
            <Button variant="outline" size="sm" disabled={busy || !canResolve} onClick={onResolve}>
              <CheckCircle2 size={16} />
              Resolve
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function TypingIndicator({ labels }: { labels: string[] }): JSX.Element {
  const visibleLabels = labels.length ? labels : ["Models"];
  return (
    <article className="thread-typing" aria-live="polite">
      <Avatar className="thread-avatar typing-avatar" spec={avatarForParticipant(visibleLabels[0])} />
      <div className="typing-bubble">
        <span>{typingText(visibleLabels)}</span>
        <span className="typing-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </div>
    </article>
  );
}

function ThreadMessage(props: {
  avatar: AvatarSpec;
  author: string;
  meta: string;
  createdAt?: string;
  title?: string;
  content: string;
  badges?: React.ReactNode;
}): JSX.Element {
  return (
    <article className="thread-message">
      <Avatar className="thread-avatar" spec={props.avatar} />
      <div className="thread-bubble">
        <div className="message-meta">
          <strong>{props.author}</strong>
          <span>{props.meta}</span>
          {props.createdAt && <span>{new Date(props.createdAt).toLocaleString()}</span>}
          {props.badges}
        </div>
        {props.title && <h3>{props.title}</h3>}
        <MarkdownText content={props.content} />
      </div>
    </article>
  );
}

type MarkdownBlock =
  | { type: "paragraph"; lines: string[] }
  | { type: "heading"; text: string }
  | { type: "code"; content: string; language?: string }
  | { type: "ul"; items: string[]; indent: number }
  | { type: "ol"; items: string[]; start?: number; indent: number }
  | { type: "table"; headers: string[]; rows: string[][] };

function MarkdownText({ content }: { content: string }): JSX.Element {
  const blocks = markdownBlocks(content);
  if (blocks.length === 0) {
    return <div className="markdown-text" />;
  }
  return <div className="markdown-text">{blocks.map((block, index) => renderMarkdownBlock(block, index))}</div>;
}

function renderMarkdownBlock(block: MarkdownBlock, index: number): React.ReactNode {
  if (block.type === "heading") {
    return <h4 key={index}>{renderInlineWithBreaks(block.text, `h-${index}`)}</h4>;
  }
  if (block.type === "code") {
    return (
      <pre className="markdown-code" key={index}>
        <code>{block.content}</code>
      </pre>
    );
  }
  if (block.type === "ol") {
    return (
      <ol className="markdown-list" key={index} start={block.start}>
        {block.items.map((item, itemIndex) => (
          <li key={itemIndex}>{renderInlineWithBreaks(item, `li-${index}-${itemIndex}`)}</li>
        ))}
      </ol>
    );
  }
  if (block.type === "ul") {
    return (
      <ul className="markdown-list" key={index}>
        {block.items.map((item, itemIndex) => (
          <li key={itemIndex}>{renderInlineWithBreaks(item, `li-${index}-${itemIndex}`)}</li>
        ))}
      </ul>
    );
  }
  if (block.type === "table") {
    return (
      <div className="markdown-table-wrap" key={index}>
        <table className="markdown-table">
          <thead>
            <tr>
              {block.headers.map((header, headerIndex) => (
                <th key={headerIndex} scope="col">
                  {renderInlineWithBreaks(header, `t-${index}-h-${headerIndex}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {block.headers.map((_, cellIndex) => (
                  <td key={cellIndex}>{renderInlineWithBreaks(row[cellIndex] ?? "", `t-${index}-${rowIndex}-${cellIndex}`)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (block.type === "paragraph") {
    return <p key={index}>{renderInlineWithBreaks(block.lines.join("\n"), `p-${index}`)}</p>;
  }
  return null;
}

function markdownBlocks(content: string): MarkdownBlock[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }

    const fence = trimmed.match(/^```(\S*)/);
    if (fence) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push({ type: "code", language: fence[1] || undefined, content: codeLines.join("\n") });
      continue;
    }

    const heading = trimmed.match(/^#{1,3}\s+(.+)$/);
    if (heading) {
      blocks.push({ type: "heading", text: heading[1].trim() });
      index += 1;
      continue;
    }

    if (isMarkdownTableStart(lines, index)) {
      const headers = parseMarkdownTableRow(lines[index]);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && isMarkdownTableRow(lines[index])) {
        rows.push(normalizeMarkdownTableRow(parseMarkdownTableRow(lines[index]), headers.length));
        index += 1;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    const listMatch = line.match(/^(\s*)(?:([-*])|(\d+)[.)])\s+(.+)$/);
    if (listMatch) {
      const indent = markdownIndent(listMatch[1]);
      const ordered = Boolean(listMatch[3]);
      const start = ordered ? Number.parseInt(listMatch[3], 10) : undefined;
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index];
        const match = current.match(/^(\s*)(?:([-*])|(\d+)[.)])\s+(.+)$/);
        if (!match || Boolean(match[3]) !== ordered || markdownIndent(match[1]) !== indent) {
          break;
        }
        items.push(match[4].trim());
        index += 1;
      }
      blocks.push(ordered ? { type: "ol", items, start, indent } : { type: "ul", items, indent });
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const current = lines[index];
      const currentTrimmed = current.trim();
      if (
        !currentTrimmed ||
        currentTrimmed.startsWith("```") ||
        /^#{1,3}\s+/.test(currentTrimmed) ||
        isMarkdownTableStart(lines, index) ||
        /^\s*(?:[-*]|\d+[.)])\s+/.test(current)
      ) {
        break;
      }
      paragraphLines.push(current);
      index += 1;
    }
    blocks.push({ type: "paragraph", lines: paragraphLines });
  }

  return normalizeOrderedListStarts(blocks);
}

function normalizeOrderedListStarts(blocks: MarkdownBlock[]): MarkdownBlock[] {
  const nextOrderedStarts = new Map<number, number>();
  const continuableOrderedIndents = new Set<number>();

  return blocks.map((block) => {
    if (block.type === "heading") {
      nextOrderedStarts.clear();
      continuableOrderedIndents.clear();
      return block;
    }

    if (block.type === "ol") {
      const requestedStart = block.start ?? 1;
      const nextStart = nextOrderedStarts.get(block.indent);
      const start = continuableOrderedIndents.has(block.indent) && requestedStart === 1 && nextStart !== undefined ? nextStart : requestedStart;
      nextOrderedStarts.set(block.indent, start + block.items.length);
      continuableOrderedIndents.add(block.indent);
      return { ...block, start };
    }

    if (block.type !== "ul") {
      nextOrderedStarts.clear();
      continuableOrderedIndents.clear();
    }

    return block;
  });
}

function markdownIndent(value: string): number {
  return value.replace(/\t/g, "    ").length;
}

function isMarkdownTableStart(lines: string[], index: number): boolean {
  if (index + 1 >= lines.length || !isMarkdownTableRow(lines[index])) {
    return false;
  }
  const headers = parseMarkdownTableRow(lines[index]);
  if (headers.length < 2) {
    return false;
  }
  const separator = parseMarkdownTableRow(lines[index + 1]);
  return separator.length === headers.length && separator.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function isMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && parseMarkdownTableRow(line).length > 1;
}

function parseMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim();
  const content = trimmed.startsWith("|") && trimmed.endsWith("|") ? trimmed.slice(1, -1) : trimmed;
  const cells: string[] = [];
  let current = "";

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character === "\\" && content[index + 1] === "|") {
      current += "|";
      index += 1;
      continue;
    }
    if (character === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  cells.push(current.trim());
  return cells;
}

function normalizeMarkdownTableRow(row: string[], columnCount: number): string[] {
  if (row.length === columnCount) {
    return row;
  }
  if (row.length > columnCount) {
    return row.slice(0, columnCount);
  }
  return [...row, ...Array.from({ length: columnCount - row.length }, () => "")];
}

function renderInlineWithBreaks(text: string, keyPrefix: string): React.ReactNode[] {
  return text.split("\n").flatMap((line, index, lines) => {
    const nodes = renderInline(line, `${keyPrefix}-${index}`);
    return index < lines.length - 1 ? [...nodes, <br key={`${keyPrefix}-br-${index}`} />] : nodes;
  });
}

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let index = 0;
  let key = 0;

  while (index < text.length) {
    if (text.startsWith("**", index)) {
      const end = text.indexOf("**", index + 2);
      if (end > index + 2) {
        nodes.push(
          <strong key={`${keyPrefix}-b-${key}`}>
            {renderInline(text.slice(index + 2, end), `${keyPrefix}-b-${key}`)}
          </strong>
        );
        key += 1;
        index = end + 2;
        continue;
      }
    }

    if (text[index] === "`") {
      const end = text.indexOf("`", index + 1);
      if (end > index + 1) {
        nodes.push(<code key={`${keyPrefix}-c-${key}`}>{text.slice(index + 1, end)}</code>);
        key += 1;
        index = end + 1;
        continue;
      }
    }

    const nextBold = text.indexOf("**", index + 1);
    const nextCode = text.indexOf("`", index + 1);
    const nextCandidates = [nextBold, nextCode].filter((candidate) => candidate > -1);
    const next = nextCandidates.length ? Math.min(...nextCandidates) : text.length;
    nodes.push(text.slice(index, next));
    index = next;
  }

  return nodes;
}

function PointsView({
  conversation,
  kind,
  isRunning
}: {
  conversation?: Conversation;
  kind: ConversationKind;
  isRunning: boolean;
}): JSX.Element {
  if (isRunning && (!conversation || conversation.findings.length === 0)) {
    return <ChartLoadingState />;
  }

  if (!conversation) {
    return <EmptyState title="No points yet" body="The final points appear after a consensus run finishes." />;
  }

  if (conversation.findings.length === 0) {
    return <EmptyState title="No points yet" body="Run consensus to produce severity-grouped points." />;
  }

  const activeFindings = conversation.findings.filter((finding) => finding.status !== "Rejected");
  const filteredOut = conversation.findings.filter((finding) => finding.status === "Rejected");

  return (
    <div className="points-view">
      <div className="view-heading">
        <h2>{kind === "code-review" ? "Review Points" : "Consensus Points"}</h2>
        <span>{conversation.findings.length} points</span>
      </div>
      {POINT_SEVERITIES.map((severity) => {
        const items =
          severity === "Low"
            ? activeFindings.filter((finding) => finding.severity === "Low" || finding.severity === "Info")
            : activeFindings.filter((finding) => finding.severity === severity);
        return (
          <section className="severity-section" key={severity}>
            <h3>
              <SeverityBadge severity={severity} />
              {items.length}
            </h3>
            <PointTable findings={items} emptyLabel="No points" />
          </section>
        );
      })}
      <section className="severity-section filtered-section">
        <h3>
          <StatusBadge tone="muted">Filtered out</StatusBadge>
          {filteredOut.length}
        </h3>
        <PointTable findings={filteredOut} emptyLabel="No filtered-out points" />
      </section>
    </div>
  );
}

function PointTable({ findings, emptyLabel }: { findings: Finding[]; emptyLabel: string }): JSX.Element {
  if (findings.length === 0) {
    return <div className="section-empty">{emptyLabel}</div>;
  }

  return (
    <div className="points-table-wrap">
      <table className="points-table">
        <thead>
          <tr>
            <th>Status</th>
            <th>Title</th>
            <th>Claim</th>
            <th>Recommended action</th>
            <th>Sources</th>
          </tr>
        </thead>
        <tbody>
          {findings.map((finding) => (
            <tr key={finding.id}>
              <td>
                <PointStatusBadge finding={finding} />
              </td>
              <td>
                <strong>{finding.title}</strong>
              </td>
              <td>{finding.claim || finding.description}</td>
              <td>{finding.action || "No specific action was provided."}</td>
              <td>
                <SourceSupportCell finding={finding} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SourceSupportCell({ finding }: { finding: Finding }): JSX.Element {
  return (
    <div className="source-support">
      <div>
        <span>Initial</span>
        <strong>{sourceLabel(finding)}</strong>
      </div>
      <div>
        <span>Confirmed</span>
        <strong>{confirmedByLabel(finding)}</strong>
      </div>
    </div>
  );
}

function PointCard({ finding, compact = false }: { finding: Finding; compact?: boolean }): JSX.Element {
  return (
    <article className={`point-card ${compact ? "compact" : ""}`}>
      <div className="point-card-head">
        <PointStatusBadge finding={finding} />
        <SeverityBadge severity={finding.severity} />
      </div>
      <h3>{finding.title}</h3>
      <dl className="point-fields">
        <div>
          <dt>Claim</dt>
          <dd>{finding.claim || finding.description}</dd>
        </div>
        <div>
          <dt>Recommended action</dt>
          <dd>{finding.action || "No specific action was provided."}</dd>
        </div>
        <div>
          <dt>Sources</dt>
          <dd>{sourceLabel(finding)}</dd>
        </div>
        <div>
          <dt>Consensus</dt>
          <dd>{consensusLine(finding)}</dd>
        </div>
      </dl>
    </article>
  );
}

const POINT_STATUS_TONE: Record<"confirmed" | "disputed" | "unresolved" | "filtered-out", StatusBadgeTone> = {
  confirmed: "success",
  disputed: "warning",
  unresolved: "neutral",
  "filtered-out": "muted"
};

function PointStatusBadge({ finding }: { finding: Finding }): JSX.Element {
  const status = pointStatus(finding);
  const Icon = status.kind === "confirmed" ? CheckCircle2 : status.kind === "filtered-out" ? XCircle : HelpCircle;
  return (
    <StatusBadge tone={POINT_STATUS_TONE[status.kind]} icon={Icon}>
      {status.label}
    </StatusBadge>
  );
}

function PlanItemReviewBadge({ review }: { review?: PlanItemReview }): JSX.Element {
  if (review) {
    return (
      <StatusBadge tone="success" icon={CheckCircle2}>
        reviewed
      </StatusBadge>
    );
  }
  return (
    <StatusBadge tone="neutral" icon={Circle}>
      pending
    </StatusBadge>
  );
}

function pointStatus(finding: Finding): { kind: "confirmed" | "disputed" | "unresolved" | "filtered-out"; label: string } {
  if (finding.status === "Confirmed") {
    return { kind: "confirmed", label: "confirmed" };
  }
  if (finding.status === "Rejected") {
    return { kind: "filtered-out", label: "filtered out" };
  }
  const hasDispute = finding.rounds.some((round) => round.stance === "rejected" || round.stance === "originator-rebuttal" || round.stance === "final-resolution");
  return hasDispute ? { kind: "disputed", label: "disputed" } : { kind: "unresolved", label: "unresolved" };
}

function liveProgressLabel(progress: ReviewProgress[]): string {
  const latest = progress[progress.length - 1];
  if (!latest) {
    return "Running";
  }
  const phase = phaseLabel(latest.phase);
  if (typeof latest.completed === "number" && typeof latest.total === "number" && latest.total > 0) {
    return `${phase}: ${latest.completed}/${latest.total} done`;
  }
  return phase;
}

function phaseLabel(phase: ReviewProgress["phase"]): string {
  return phase
    .split("-")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

interface TimelineMessageDisplay {
  content: string;
  markdown: boolean;
}

interface LineProtocolItem {
  title: string;
  severity?: string;
  claim?: string;
  evidence?: string;
  action?: string;
}

function displayMessageContent(message: Conversation["messages"][number], kind: ConversationKind): TimelineMessageDisplay {
  const content = summarizeRawProviderJson(message.content) ?? message.content;
  if (kind === "implementation-plan" && (message.role === "participant" || message.role === "summary")) {
    return { content, markdown: true };
  }
  const protocolSummary = formatLineProtocolForTimeline(message, kind, content);
  const displayContent = protocolSummary ?? content;
  return { content: displayContent, markdown: Boolean(protocolSummary) };
}

function isHiddenImplementationPlanInternalMessage(message: Conversation["messages"][number], kind: ConversationKind): boolean {
  if (kind !== "implementation-plan") {
    return false;
  }
  if (message.role === "participant" && message.participantId?.startsWith("arbiter:")) {
    return true;
  }
  return message.role === "user" && message.content.trimStart().startsWith("Implementation-plan decision threads continued:");
}

function formatLineProtocolForTimeline(
  message: Conversation["messages"][number],
  kind: ConversationKind,
  content: string
): string | undefined {
  if (message.role !== "participant" || message.status === "error") {
    return undefined;
  }
  const items = parseLineProtocolItems(content);
  if (!items.length) {
    return undefined;
  }

  const labels = { claim: "Claim", evidence: "Evidence", action: "Action" };

  return items
    .map((item, index) =>
      [
        `### ${index + 1}. ${item.title || "Untitled item"}`,
        item.claim ? `**${labels.claim}:** ${item.claim}` : "",
        item.evidence ? `**${labels.evidence}:** ${item.evidence}` : "",
        item.action ? `**${labels.action}:** ${item.action}` : ""
      ]
        .filter(Boolean)
        .join("\n\n")
    )
    .join("\n\n");
}

function parseLineProtocolItems(content: string): LineProtocolItem[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const items: LineProtocolItem[] = [];
  let current: LineProtocolItem | undefined;
  let currentField: "claim" | "evidence" | "action" | undefined;

  const appendField = (field: "claim" | "evidence" | "action", value: string): void => {
    if (!current) {
      return;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    current[field] = current[field] ? `${current[field]}\n${trimmed}` : trimmed;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      currentField = undefined;
      continue;
    }

    const header = trimmed.match(/^[PK]\d+\|(.+)$/i);
    if (header) {
      current = parseLineProtocolHeader(header[1]);
      items.push(current);
      currentField = undefined;
      continue;
    }

    const field = trimmed.match(/^([CEA]):\s*(.*)$/i);
    if (field && current) {
      const key = field[1].toUpperCase();
      currentField = key === "C" ? "claim" : key === "E" ? "evidence" : "action";
      appendField(currentField, field[2]);
      continue;
    }

    if (current && currentField && !/^[A-Z][A-Z0-9_ -]{0,24}:/i.test(trimmed)) {
      appendField(currentField, trimmed);
    }
  }

  return items.filter((item) => item.title || item.claim || item.evidence || item.action);
}

function parseLineProtocolHeader(header: string): LineProtocolItem {
  const fields = header.split("|");
  const item: LineProtocolItem = { title: "" };
  for (const field of fields) {
    const match = field.match(/^([A-Z]+):\s*(.*)$/i);
    if (!match) {
      continue;
    }
    const key = match[1].toUpperCase();
    const value = match[2].trim();
    if (key === "T") {
      item.title = value;
    } else if (key === "S") {
      item.severity = value;
    }
  }
  return item;
}

function displayNoticeText(content: string): string {
  return sanitizeWarningText(content, MAX_NOTICE_CHARS);
}

function summarizeRawProviderJson(content: string): string | undefined {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }
  try {
    const data = JSON.parse(trimmed) as {
      object?: string;
      status?: string;
      model?: string;
      incomplete_details?: { reason?: string };
      output?: unknown[];
    };
    if (data.object !== "response") {
      return undefined;
    }
    if (data.status === "incomplete") {
      const reason = data.incomplete_details?.reason ?? "unknown reason";
      const model = data.model ? ` from ${data.model}` : "";
      return `OpenAI returned an incomplete response${model}: ${reason}. No usable text was produced.`;
    }
    return `OpenAI returned a response object without usable text output${data.status ? ` (status: ${data.status})` : ""}.`;
  } catch {
    return undefined;
  }
}

function mergeProgressIntoConversation(conversation: Conversation, _progress: ReviewProgress[]): Conversation {
  const messages = conversation.messages.filter((message) => !message.progressPhase);
  if (messages.length === conversation.messages.length) {
    return conversation;
  }

  return { ...conversation, messages };
}

function chatThinkingRows(progress: ReviewProgress[]): ChatThinkingRow[] {
  const rows = new Map<string, ChatThinkingRow>();
  for (const item of progress) {
    if (item.phase === "done" || item.phase === "cancelled" || item.phase === "error") {
      rows.clear();
      continue;
    }
    const agentProgress = item.agentProgress;
    if (!agentProgress) {
      continue;
    }
    const participantLabel = agentProgress.participantLabel || item.participantLabel || "Agent";
    const key = agentProgress.participantId || participantLabel;
    if (agentProgress.state === "finished") {
      rows.delete(key);
      continue;
    }
    const current = rows.get(key);
    rows.set(key, {
      key,
      participantId: agentProgress.participantId ?? current?.participantId,
      participantLabel,
      activity: agentProgress.activity?.trim() || current?.activity,
      startedAt: current?.startedAt ?? item.createdAt,
      updatedAt: item.createdAt
    });
  }
  return Array.from(rows.values()).sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

function conversationRunId(conversation: Conversation): string {
  return metadataString(conversation.metadata.runId) || conversation.id;
}

function conversationMatchesSnapshot(current: Conversation | undefined, updated: Conversation, currentRunId: string | undefined): boolean {
  if (!current) {
    return false;
  }
  const currentRun = metadataString(current.metadata.runId);
  const updatedRun = metadataString(updated.metadata.runId);
  return (
    current.id === updated.id ||
    Boolean(currentRun && updatedRun && currentRun === updatedRun) ||
    Boolean(currentRunId && updatedRun && currentRunId === updatedRun) ||
    Boolean(updatedRun && current.id === updatedRun)
  );
}

function threadExistsInConversation(conversation: Conversation, threadId: string): boolean {
  return (
    timelineFindings(conversation).some((finding) => finding.id === threadId) ||
    visiblePlanDecisionRequests(conversation).some((decision) => decision.id === threadId) ||
    conversation.messages.some((message) => message.metadata?.threadId === threadId || message.id === threadId)
  );
}

function authorForMessage(message: Conversation["messages"][number], kind: ConversationKind): string {
  if (message.role === "user") {
    return "You";
  }
  if (kind === "implementation-plan" && (message.role === "system" || message.role === "summary" || message.participantId?.startsWith("arbiter:"))) {
    return "Planner";
  }
  if (message.role === "system") {
    return "Arbiter";
  }
  if (message.participantLabel?.toLowerCase().includes("(arbiter)") || message.participantLabel?.toLowerCase().includes("(planner)")) {
    return "Arbiter";
  }
  return message.participantLabel || labelForRole(message.role);
}

function Avatar({ className, spec }: { className: string; spec: AvatarSpec }): JSX.Element {
  return (
    <div className={`${className} avatar-icon avatar-${spec.kind}`} title={spec.label} aria-label={spec.label}>
      {avatarGraphic(spec)}
    </div>
  );
}

function avatarGraphic(spec: AvatarSpec): React.ReactNode {
  if (spec.kind === "user") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="8.2" r="5.1" />
        <path d="M3.6 22.2c1.3-5.1 4.2-7.6 8.4-7.6s7.1 2.5 8.4 7.6z" />
      </svg>
    );
  }
  if (spec.kind === "arbiter") {
    return <img src={JUDGE_FLATICON_URL} alt="" aria-hidden="true" />;
  }
  if (spec.kind === "anthropic") {
    return <img className="provider-avatar-image" src={CLAUDE_AVATAR_URL} alt="" aria-hidden="true" />;
  }
  if (spec.kind === "codex") {
    return <img className="provider-avatar-image" src={CODEX_AVATAR_URL} alt="" aria-hidden="true" />;
  }
  if (spec.kind === "custom" && spec.imageUrl) {
    return <img className="custom-avatar-image" src={spec.imageUrl} alt="" aria-hidden="true" />;
  }
  if (spec.kind === "gemini") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 2.8c1 5 4.2 8.2 9.2 9.2-5 1-8.2 4.2-9.2 9.2-1-5-4.2-8.2-9.2-9.2 5-1 8.2-4.2 9.2-9.2Z" />
      </svg>
    );
  }
  return <span>{spec.initials || initials(spec.label)}</span>;
}

function chatAvatarOptionsForKind(kind: ChatProviderKind): ChatAvatarOption[] {
  return CHAT_AVATAR_OPTIONS.filter((option) => option.kind === kind);
}

function chatAvatarOption(avatarId: string | undefined): ChatAvatarOption | undefined {
  return CHAT_AVATAR_OPTIONS.find((option) => option.id === avatarId);
}

function isChatAvatarIdForKind(avatarId: string | undefined, kind: ChatProviderKind): boolean {
  return chatAvatarOption(avatarId)?.kind === kind;
}

function defaultChatAvatarId(kind: ChatProviderKind, seed = ""): ChatAvatarId {
  const options = chatAvatarOptionsForKind(kind);
  const fallback = kind === "claude-code" ? "claude-human" : "codex-human";
  if (options.length === 0) {
    return fallback;
  }
  const normalizedSeed = seed.trim().toLowerCase();
  const index = normalizedSeed ? stableHash(normalizedSeed) % options.length : 0;
  return options[index]?.id ?? fallback;
}

function normalizedChatAvatarId(kind: ChatProviderKind, avatarId: string | undefined, seed = ""): ChatAvatarId {
  const option = chatAvatarOption(avatarId);
  if (option?.kind === kind) {
    return option.id;
  }
  return defaultChatAvatarId(kind, seed);
}

function avatarForChatAvatarOption(option: ChatAvatarOption, label = option.label): AvatarSpec {
  return { kind: "custom", label, imageUrl: option.imageUrl };
}

function avatarForChatParticipant(participant: Pick<ChatParticipant, "id" | "handle" | "kind" | "avatarId">, label = `@${participant.handle}`): AvatarSpec {
  const avatarId = normalizedChatAvatarId(participant.kind, participant.avatarId, participant.id || participant.handle);
  const option = chatAvatarOption(avatarId);
  return option ? avatarForChatAvatarOption(option, label) : avatarForParticipant(label, participant.id);
}

function stableHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function avatarForMessage(message: Conversation["messages"][number], author: string, participant?: ChatParticipant): AvatarSpec {
  if (message.role === "user") {
    return USER_AVATAR;
  }
  if (message.role === "system" || message.role === "summary" || message.participantId?.startsWith("arbiter:")) {
    return { ...ARBITER_AVATAR, label: author };
  }
  if (participant) {
    return avatarForChatParticipant(participant, author);
  }
  return avatarForParticipant(author, message.participantId);
}

function avatarForParticipant(label: string, participantId?: string): AvatarSpec {
  const text = `${participantId ?? ""} ${label}`.toLowerCase();
  if (text.includes("arbiter") || text.includes("planner")) {
    return ARBITER_AVATAR;
  }
  if (text.includes("claude") || text.includes("anthropic")) {
    return { kind: "anthropic", label };
  }
  if (text.includes("codex") || text.includes("openai")) {
    return { kind: "codex", label };
  }
  if (text.includes("gemini")) {
    return { kind: "gemini", label };
  }
  return { kind: "generic", label, initials: initials(label) };
}

function stanceLabel(stance: string): string {
  return stance
    .split("-")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function pointThreadReplies(finding: Finding): Array<{ id: string; author: string; meta: string; createdAt?: string; content: string; order: number }> {
  const sourceReplies = finding.sourceItems?.length
    ? []
    : (() => {
        const sourceLabels = finding.sourceParticipantLabels?.length ? finding.sourceParticipantLabels : [finding.sourceParticipantLabel];
        const sourceIds = finding.sourceParticipantIds?.length ? finding.sourceParticipantIds : [finding.sourceParticipantId];
        return sourceLabels.map((label, index) => ({
          id: `source-${sourceIds[index] ?? label}-${index}`,
          author: label,
          meta: "Initial point",
          createdAt: finding.createdAt,
          content: pointSourceContent(finding),
          order: index
        }));
      })();
  const roundReplies = finding.rounds.map((round, index) => ({
    id: round.id,
    author: round.participantLabel,
    meta: stanceLabel(round.stance),
    createdAt: round.createdAt,
    content: round.content,
    order: sourceReplies.length + index
  }));

  return [...sourceReplies, ...roundReplies].sort((left, right) => {
    const leftTime = left.createdAt ? Date.parse(left.createdAt) : 0;
    const rightTime = right.createdAt ? Date.parse(right.createdAt) : 0;
    return leftTime - rightTime || left.order - right.order;
  });
}

function canonicalPlanItemContent(finding: Finding): string {
  return [
    `**Decision:** ${finding.claim || finding.description}`,
    finding.evidence ? `**Context:** ${finding.evidence}` : "",
    finding.action ? `**Next steps:** ${finding.action}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

function sourceItemContent(item: NonNullable<Finding["sourceItems"]>[number]): string {
  if (item.rawContent?.trim()) {
    return item.rawContent.trim();
  }
  return [
    item.title ? `Title: ${item.title}` : "",
    item.claim ? `Claim: ${item.claim}` : "",
    item.evidence ? `Evidence: ${item.evidence}` : "",
    item.action ? `Recommended action: ${item.action}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

function pointSourceContent(finding: Finding): string {
  return [
    finding.claim ? `Claim: ${finding.claim}` : finding.description,
    finding.evidence ? `Evidence: ${finding.evidence}` : "",
    finding.action ? `Recommended action: ${finding.action}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

function initials(value: string): string {
  return (
    value
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "M"
  );
}

function sourceLabel(finding: Finding): string {
  return finding.sourceParticipantLabels?.length ? finding.sourceParticipantLabels.join(", ") : finding.sourceParticipantLabel;
}

function sourceLabelForDecision(decision: PlanDecisionRequest): string {
  return decision.sourceParticipantLabels?.length ? decision.sourceParticipantLabels.join(", ") : "Agent";
}

function confirmedByLabel(finding: Finding): string {
  const labels = new Set<string>();
  const sourceLabels = finding.sourceParticipantLabels?.length ? finding.sourceParticipantLabels : [finding.sourceParticipantLabel];
  for (const label of sourceLabels) {
    if (label) {
      labels.add(label);
    }
  }
  for (const round of finding.rounds) {
    if (round.stance === "confirmed" && round.participantLabel) {
      labels.add(round.participantLabel);
    }
  }
  return Array.from(labels).join(", ") || "None";
}

function consensusLine(finding: Finding): string {
  const included = finding.includedParticipantIds?.length ?? 0;
  const missing = finding.missingParticipantIds?.length ?? 0;
  const replies = finding.rounds.length;
  const status = pointStatus(finding).label;
  return `${status}; ${included} initial source${included === 1 ? "" : "s"}, ${missing} verification target${missing === 1 ? "" : "s"}, ${replies} thread ${replies === 1 ? "reply" : "replies"}.`;
}

function metadataString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function hasFallbackFinalPlan(conversation: Conversation): boolean {
  const source = metadataString(conversation.metadata.implementationPlanSynthesisSource);
  if (source === "fallback") {
    return true;
  }
  if (source === "arbiter") {
    return false;
  }
  const warnings = Array.isArray(conversation.metadata.warnings)
    ? conversation.metadata.warnings.filter((item): item is string => typeof item === "string")
    : [];
  return warnings.some((warning) => {
    const normalized = warning.toLowerCase();
    return normalized.includes("used local summary fallback") || normalized.includes("could not synthesize the final implementation plan");
  });
}

function EmptyState({ title, body }: { title: string; body: string }): JSX.Element {
  return (
    <div className="empty-state">
      <HelpCircle size={26} />
      <h2>{title}</h2>
      <p>{body}</p>
    </div>
  );
}

function labelForRole(role: string): string {
  if (role === "system") {
    return "Consensus engine";
  }
  if (role === "summary") {
    return "Final summary";
  }
  return role;
}

function labelForKind(kind: ConversationKind): string {
  if (kind === "code-review") {
    return "Code review";
  }
  if (kind === "implementation-plan") {
    return "Implementation plan";
  }
  if (kind === "chat") {
    return "Chat";
  }
  return "Question";
}

function titleForKind(kind: ConversationKind): string {
  if (kind === "implementation-plan") {
    return "Implementation plan";
  }
  if (kind === "code-review") {
    return "Consensus review";
  }
  if (kind === "chat") {
    return "Chat";
  }
  return "Consensus question";
}

function requiresRepo(kind: ConversationKind): boolean {
  return kind === "code-review" || kind === "implementation-plan";
}

const CHAT_NAME_POOL = ["alex", "blake", "casey", "drew", "ellis", "harper", "jamie", "jordan", "morgan", "quinn", "riley", "sam", "taylor"];

function defaultChatParticipantDraft(settings: AppSettings, existingHandles: Set<string> = new Set()): ChatParticipantDraft {
  const provider = settings.providers.find((item) => item.kind === "codex-cli") ?? settings.providers.find((item) => item.kind === "claude-code");
  const roleConfigId = settings.chatRoleConfigs[0]?.id ?? "";
  const kind = provider?.kind === "claude-code" ? "claude-code" : "codex-cli";
  const handle = roleConfigId ? generatedChatHandle(settings, kind, roleConfigId, existingHandles) : "";
  return {
    handle,
    roleConfigId,
    kind,
    model: provider?.model,
    avatarId: defaultChatAvatarId(kind, handle || roleConfigId)
  };
}

function chatParticipantConfigToDraft(participant: ChatParticipantConfig): ChatParticipantDraft {
  return {
    handle: participant.handle,
    roleConfigId: participant.roleConfigId,
    kind: participant.kind,
    model: participant.model,
    avatarId: normalizedChatAvatarId(participant.kind, participant.avatarId, participant.id || participant.handle)
  };
}

function selectedChatParticipantDrafts(participants: ChatParticipantConfig[], selectedIds: Set<string>): ChatParticipantDraft[] {
  return participants.filter((participant) => selectedIds.has(participant.id)).map(chatParticipantConfigToDraft);
}

function sameParticipantDraft(draft: ChatParticipantDraft, participant: ChatParticipantConfig): boolean {
  return (
    draft.handle === participant.handle &&
    draft.roleConfigId === participant.roleConfigId &&
    draft.kind === participant.kind &&
    (draft.model ?? "") === (participant.model ?? "") &&
    normalizedChatAvatarId(draft.kind, draft.avatarId, draft.handle) === normalizedChatAvatarId(participant.kind, participant.avatarId, participant.id || participant.handle)
  );
}

function labelForProviderKind(providers: ProviderSettings[], kind: ProviderKind): string {
  return providers.find((provider) => provider.kind === kind)?.label ?? kind;
}

function normalizeChatParticipantDraftForSettings(draft: ChatParticipantDraft, settings: AppSettings): ChatParticipantDraft {
  const fallback = defaultChatParticipantDraft(settings);
  const roleConfigId = settings.chatRoleConfigs.some((role) => role.id === draft.roleConfigId)
    ? draft.roleConfigId
    : fallback.roleConfigId;
  const provider = settings.providers.find((item) => item.kind === draft.kind) ?? settings.providers.find((item) => item.kind === fallback.kind);
  const kind = provider?.kind === "claude-code" ? "claude-code" : "codex-cli";
  const handle = draft.handle.trim() || (roleConfigId ? generatedChatHandle(settings, kind, roleConfigId) : "");
  return {
    ...draft,
    handle,
    roleConfigId,
    kind,
    model: draft.model ?? provider?.model,
    avatarId: normalizedChatAvatarId(kind, draft.avatarId, handle || roleConfigId)
  };
}

function updateChatParticipantDraft(
  draft: ChatParticipantDraft,
  settings: AppSettings,
  patch: Partial<Pick<ChatParticipantDraft, "roleConfigId" | "kind" | "avatarId">>
): ChatParticipantDraft {
  let next = { ...draft, ...patch };
  if (!isChatAvatarIdForKind(next.avatarId, next.kind)) {
    next = { ...next, avatarId: defaultChatAvatarId(next.kind, next.handle || next.roleConfigId) };
  }
  if (!draft.handle.trim() || isGeneratedChatHandle(draft.handle)) {
    const handle = generatedChatHandle(settings, next.kind, next.roleConfigId);
    return {
      ...next,
      handle,
      avatarId: normalizedChatAvatarId(next.kind, next.avatarId, handle)
    };
  }
  return next;
}

function generatedChatHandle(settings: AppSettings, kind: ChatProviderKind, roleConfigId: string, existingHandles: Set<string> = new Set()): string {
  const roleLabel = settings.chatRoleConfigs.find((role) => role.id === roleConfigId)?.label ?? roleConfigId;
  const name = CHAT_NAME_POOL[Math.floor(Math.random() * CHAT_NAME_POOL.length)] ?? "alex";
  const cli = kind === "claude-code" ? "claude" : "codex";
  const role = compactRoleSlug(roleLabel);
  const base = truncateHandle(`${name}-${cli}-${role}`, 32);
  let candidate = base;
  let suffix = 2;
  while (existingHandles.has(candidate.toLowerCase())) {
    const suffixText = `-${suffix}`;
    candidate = `${truncateHandle(base, 32 - suffixText.length)}${suffixText}`;
    suffix += 1;
  }
  return candidate;
}

function compactRoleSlug(label: string): string {
  const normalized = slugHandle(label);
  if (normalized.includes("synth")) {
    return "synthesizer";
  }
  if (normalized.includes("arbiter")) {
    return "arbiter";
  }
  if (normalized.includes("engineer")) {
    return "engineer";
  }
  return truncateHandle(normalized || "agent", 14);
}

function slugHandle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function truncateHandle(value: string, maxLength: number): string {
  return value.slice(0, maxLength).replace(/-+$/g, "") || "agent";
}

function isGeneratedChatHandle(handle: string): boolean {
  const [name, cli] = handle.toLowerCase().split("-");
  return CHAT_NAME_POOL.includes(name) && (cli === "codex" || cli === "claude");
}

function normalizedChatDrafts(drafts: ChatParticipantDraft[]): ChatParticipantDraft[] {
  return drafts.map((draft) => ({
    handle: draft.handle.trim().replace(/^@/, ""),
    roleConfigId: draft.roleConfigId,
    kind: draft.kind,
    model: draft.model?.trim() || undefined,
    avatarId: normalizedChatAvatarId(draft.kind, draft.avatarId, draft.handle)
  }));
}

function validateChatParticipantDrafts(
  drafts: ChatParticipantDraft[],
  roles: ChatRoleConfig[],
  existingHandles: Set<string> = new Set()
): string | undefined {
  if (drafts.length === 0) {
    return "Add at least one participant.";
  }
  const handles = new Set(existingHandles);
  for (const draft of drafts) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(draft.handle)) {
      return "Participant names may use letters, numbers, underscores, and hyphens only.";
    }
    const normalized = draft.handle.toLowerCase();
    if (handles.has(normalized)) {
      return `Duplicate participant name: @${draft.handle}.`;
    }
    handles.add(normalized);
    if (!roles.some((role) => role.id === draft.roleConfigId)) {
      return "Select a role for every participant.";
    }
    if (draft.kind !== "codex-cli" && draft.kind !== "claude-code") {
      return "Chat supports local CLI participants only.";
    }
    if (draft.avatarId && !isChatAvatarIdForKind(draft.avatarId, draft.kind)) {
      return "Select an avatar that matches the participant CLI.";
    }
  }
  return undefined;
}

function validateChatCliAgents(drafts: ChatParticipantDraft[], agents: AgentHealth[]): string | undefined {
  for (const draft of drafts) {
    const health = agents.find((agent) => agent.kind === draft.kind);
    if (!health?.installed) {
      return `${draft.kind === "codex-cli" ? "Codex CLI" : "Claude Code"} is not installed.`;
    }
  }
  return undefined;
}

function chatParticipants(conversation: Conversation | undefined): ChatParticipant[] {
  const value = conversation?.metadata.participants;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is ChatParticipant => {
    const participant = item as Partial<ChatParticipant>;
    return (
      typeof participant.id === "string" &&
      typeof participant.handle === "string" &&
      typeof participant.roleConfigId === "string" &&
      (participant.kind === "codex-cli" || participant.kind === "claude-code")
    );
  });
}

function chatTopLevelMessages(conversation: Conversation): Conversation["messages"] {
  return conversation.messages.filter((message) => !chatVisualThreadRootId(message));
}

function chatThreadSummaryMap(conversation: Conversation): Map<string, { replies: Conversation["messages"]; latestReplyAt?: string }> {
  const summaries = new Map<string, { replies: Conversation["messages"]; latestReplyAt?: string }>();
  for (const message of conversation.messages) {
    const rootId = chatVisualThreadRootId(message);
    if (!rootId) {
      continue;
    }
    const summary = summaries.get(rootId) ?? { replies: [] };
    summary.replies.push(message);
    if (!summary.latestReplyAt || Date.parse(message.createdAt) > Date.parse(summary.latestReplyAt)) {
      summary.latestReplyAt = message.createdAt;
    }
    summaries.set(rootId, summary);
  }
  for (const summary of summaries.values()) {
    summary.replies.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  }
  return summaries;
}

function chatContinuedMentionRequestIds(conversation: Conversation): Set<string> {
  return new Set(
    conversation.messages
      .filter((message) => message.metadata?.approvedContinuation && message.metadata.sourceMessageId)
      .map((message) => message.metadata?.sourceMessageId as string)
  );
}

function chatVisualThreadRootId(message: Conversation["messages"][number]): string | undefined {
  if (message.metadata?.chatThreadRootId) {
    return message.metadata.chatThreadRootId;
  }
  if (message.role === "user" && message.metadata?.parentMessageId) {
    return message.metadata.threadId ?? message.metadata.parentMessageId;
  }
  return undefined;
}

function formatChatReplyDate(value: string): string {
  return new Date(value).toLocaleString();
}

function formatChatChoiceReceiptTime(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true }).toUpperCase();
}

function chatRoleLabel(roles: ChatRoleConfig[], participant: Pick<ChatParticipant, "roleConfigId">): string {
  return roles.find((role) => role.id === participant.roleConfigId)?.label ?? participant.roleConfigId;
}

function chatDisplayContent(message: Conversation["messages"][number], author: string): string {
  if (message.role !== "participant") {
    return message.content;
  }
  const lines = message.content.replace(/\r\n/g, "\n").split("\n");
  const firstContentIndex = lines.findIndex((line) => line.trim());
  if (firstContentIndex < 0) {
    return "";
  }
  const firstLine = lines[firstContentIndex].trim();
  const labels = [author, message.participantLabel].filter((value): value is string => Boolean(value));
  if (!labels.some((label) => firstLine === label || firstLine === `@${label.replace(/^@/, "")}`)) {
    return stripChatControlBlocks(message.content);
  }
  const next = [...lines.slice(0, firstContentIndex), ...lines.slice(firstContentIndex + 1)];
  while (next.length > 0 && !next[0].trim()) {
    next.shift();
  }
  return stripChatControlBlocks(next.join("\n"));
}

function stripChatControlBlocks(content: string): string {
  return stripUserChoiceBlocks(stripNoParticipantRequests(content)).trimEnd();
}

function stripNoParticipantRequests(content: string): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const next: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (/^participant requests\s*:\s*none\.?$/i.test(trimmed)) {
      continue;
    }
    if (/^participant requests\s*:\s*$/i.test(trimmed)) {
      const following = lines[index + 1]?.trim();
      if (following && /^(?:[-*]|\d+[.)])\s+none\.?$/i.test(following)) {
        index += 1;
        continue;
      }
    }
    next.push(line);
  }
  return next.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function stripUserChoiceBlocks(content: string): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const nextLines: string[] = [];
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (/^```/.test(trimmed)) {
      inFence = !inFence;
      nextLines.push(lines[index]);
      continue;
    }
    if (inFence || !/^user choice\s*:/i.test(trimmed)) {
      nextLines.push(lines[index]);
      continue;
    }
    for (let blockIndex = index + 1; blockIndex < lines.length; blockIndex += 1) {
      const blockTrimmed = lines[blockIndex].trim();
      if (!blockTrimmed) {
        index = blockIndex;
        continue;
      }
      if (isUserChoiceDisplayProtocolLine(blockTrimmed)) {
        index = blockIndex;
        continue;
      }
      break;
    }
  }
  return nextLines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function isUserChoiceDisplayProtocolLine(line: string): boolean {
  const normalized = line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim();
  return /^(?:T|TITLE|Q|QUESTION|R|RECOMMENDED|O\d+)\s*[:|]/i.test(normalized);
}

function activeMentionQuery(value: string): string | undefined {
  const match = value.match(/(?:^|\s)@([A-Za-z0-9_-]*)$/);
  return match ? match[1] : undefined;
}

function replaceActiveMention(value: string, handle: string): string {
  const match = value.match(/(?:^|\s)@([A-Za-z0-9_-]*)$/);
  if (!match || match.index === undefined) {
    return `${value}${value.endsWith(" ") || !value ? "" : " "}@${handle} `;
  }
  const prefix = value.slice(0, match.index);
  const leadingSpace = match[0].startsWith(" ") ? " " : "";
  return `${prefix}${leadingSpace}@${handle} `;
}

function pendingPlanDecisions(conversation: Conversation | undefined): PlanDecisionRequest[] {
  const value = conversation?.metadata.pendingDecisions;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is PlanDecisionRequest => {
    const decision = item as Partial<PlanDecisionRequest>;
    return (
      typeof decision.id === "string" &&
      typeof decision.title === "string" &&
      typeof decision.question === "string" &&
      Array.isArray(decision.options)
    );
  });
}

function planDecisionRequests(conversation: Conversation | undefined): PlanDecisionRequest[] {
  const value = conversation?.metadata.planDecisionRequests;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isPlanDecisionRequest);
}

function visiblePlanDecisionRequests(conversation: Conversation | undefined): PlanDecisionRequest[] {
  if (!conversation) {
    return [];
  }
  const merged = mergePlanDecisionRequests(planDecisionRequests(conversation), pendingPlanDecisions(conversation));
  const byId = new Map(merged.map((decision) => [decision.id, decision]));
  implementationPlanAnswers(conversation).forEach((answer, index) => {
    if (!byId.has(answer.decisionId)) {
      const fallback = fallbackDecisionRequestFromAnswer(answer, conversation.updatedAt, index);
      if (fallback) {
        byId.set(fallback.id, fallback);
      }
    }
  });
  return Array.from(byId.values());
}

function isPlanDecisionRequest(item: unknown): item is PlanDecisionRequest {
  const decision = item as Partial<PlanDecisionRequest>;
  return (
    typeof decision.id === "string" &&
    typeof decision.title === "string" &&
    typeof decision.question === "string" &&
    Array.isArray(decision.options)
  );
}

function mergePlanDecisionRequests(existing: PlanDecisionRequest[], next: PlanDecisionRequest[]): PlanDecisionRequest[] {
  const merged = new Map<string, PlanDecisionRequest>();
  for (const decision of [...existing, ...next]) {
    if (decision.id.trim() && decision.question.trim()) {
      merged.set(decision.id, decision);
    }
  }
  return Array.from(merged.values());
}

function fallbackDecisionRequestFromAnswer(answer: PlanDecisionAnswer, createdAt: string, index: number): PlanDecisionRequest | undefined {
  if (!answer.decisionId.trim() || !answer.answer.trim()) {
    return undefined;
  }
  const title = answer.answer.match(/^Decision:\s*(.+)$/m)?.[1]?.trim();
  const question = answer.answer.match(/^Question:\s*(.+)$/m)?.[1]?.trim();
  const selectedLabel = answer.answer.match(/^Selected option:\s*(.+)$/m)?.[1]?.trim();
  const optionId = answer.selectedOptionId?.trim();
  const optionLabel = selectedLabel || optionId;
  const firstContentLine = answer.answer
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !/^(Decision|Question|Selected option|Thread transcript|Automatic answer|Reason):/i.test(line));
  const option = optionLabel
    ? [{ id: optionId || "answered", label: optionLabel }]
    : [];
  return {
    id: answer.decisionId,
    title: title || `Decision answer ${index + 1}`,
    question: question || firstContentLine || "Saved decision answer",
    impact: "Saved answer from a previous decision thread.",
    options: option,
    recommendedOptionId: optionId && option.some((item) => item.id === optionId) ? optionId : undefined,
    sourceParticipantIds: [],
    sourceParticipantLabels: ["Agent"],
    createdAt
  };
}

function pendingPlanItemReview(conversation: Conversation | undefined): boolean {
  return conversation?.kind === "implementation-plan" && conversation.metadata.pendingPlanItemReview === true;
}

function timelineFindings(conversation: Conversation): Finding[] {
  if (conversation.kind === "implementation-plan") {
    const actionIds = new Set(requiredPlanItemReviewFindings(conversation).map((finding) => finding.id));
    return conversation.findings.filter((finding) => actionIds.has(finding.id));
  }
  return conversation.findings;
}

function hasFinalImplementationPlan(conversation: Conversation | undefined): boolean {
  if (!conversation || conversation.kind !== "implementation-plan") {
    return false;
  }
  if (!conversation.findings.some((finding) => finding.status === "Confirmed")) {
    return false;
  }
  return Boolean(
    metadataString(conversation.metadata.implementationPlanFinalMarkdown) ||
    conversation.finalSummary?.trim() ||
    conversation.messages.some((message) => message.role === "summary" && message.content.trim())
  );
}

function canRecoverImplementationPlan(conversation: Conversation | undefined, busy: boolean): boolean {
  if (busy || !conversation || conversation.kind !== "implementation-plan") {
    return false;
  }
  if (pendingPlanDecisions(conversation).length > 0 || pendingPlanItemReview(conversation)) {
    return false;
  }
  const hasStoredPlan = Boolean(
    metadataString(conversation.metadata.implementationPlanFinalMarkdown) ||
    conversation.finalSummary?.trim() ||
    conversation.messages.some((message) => message.role === "summary" && message.content.trim())
  );
  if (hasStoredPlan) {
    return false;
  }
  const request = conversation.metadata.implementationPlanRequest;
  return Boolean(request && typeof request === "object");
}

function planItemReviews(conversation: Conversation | undefined): PlanItemReview[] {
  const value = conversation?.metadata.planItemReviews;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is PlanItemReview => {
    const review = item as Partial<PlanItemReview>;
    return (
      typeof review.findingId === "string" &&
      (review.status === "confirmed" || review.status === "commented") &&
      typeof review.createdAt === "string" &&
      typeof review.updatedAt === "string" &&
      (review.comment === undefined || typeof review.comment === "string")
    );
  });
}

function requiredPlanItemReviewFindings(conversation: Conversation | undefined): Finding[] {
  if (!conversation || !pendingPlanItemReview(conversation)) {
    return [];
  }
  return conversation.findings.filter((finding) => finding.status === "Confirmed" && planItemRequiresReview(finding));
}

function planItemRequiresReview(finding: Finding): boolean {
  return finding.rounds.some((round) => round.stance !== "confirmed");
}

function planItemReviewForFinding(finding: Finding, reviews: PlanItemReview[]): PlanItemReview | undefined {
  const review = reviews.find((item) => item.findingId === finding.id);
  if (!review) {
    return undefined;
  }
  if (review.status === "confirmed") {
    return review;
  }
  return review.comment?.trim() ? review : undefined;
}

function firstPendingPlanItemReview(conversation: Conversation | undefined): Finding | undefined {
  const reviews = planItemReviews(conversation);
  return requiredPlanItemReviewFindings(conversation).find((finding) => !planItemReviewForFinding(finding, reviews));
}

function decisionTypingLabels(decision: PlanDecisionRequest, progress: ReviewProgress[], isRunning: boolean): string[] {
  if (!isRunning) {
    return [];
  }
  const relevant = progress
    .filter((item) => item.phase === "decisions" && item.findingTitle === decision.title && item.participantLabel)
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  const latest = relevant[relevant.length - 1];
  return latest?.participantLabel ? [latest.participantLabel] : [];
}

function typingText(labels: string[]): string {
  if (labels.length === 0 || labels[0] === "Models") {
    return "Models are typing";
  }
  if (labels.length === 1) {
    return `${labels[0]} is typing`;
  }
  if (labels.length === 2) {
    return `${labels[0]} and ${labels[1]} are typing`;
  }
  return `${labels[0]} and ${labels.length - 1} others are typing`;
}

function planDecisionReplies(conversation: Conversation | undefined): PlanDecisionReply[] {
  const value = conversation?.metadata.planDecisionReplies;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is PlanDecisionReply => {
    const reply = item as Partial<PlanDecisionReply>;
    return (
      typeof reply.id === "string" &&
      typeof reply.decisionId === "string" &&
      typeof reply.role === "string" &&
      typeof reply.content === "string" &&
      typeof reply.createdAt === "string"
    );
  });
}

function implementationPlanAnswers(conversation: Conversation | undefined): PlanDecisionAnswer[] {
  const value = conversation?.metadata.implementationPlanAnswers;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is PlanDecisionAnswer => {
    const answer = item as Partial<PlanDecisionAnswer>;
    return typeof answer.decisionId === "string" && typeof answer.answer === "string";
  });
}

function pendingDecisionSelections(conversation: Conversation | undefined): Record<string, string> {
  const value = conversation?.metadata.pendingDecisionSelections;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
  );
}

function pendingDecisionResolutions(conversation: Conversation | undefined): Record<string, boolean> {
  const value = conversation?.metadata.pendingDecisionResolutions;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[0] === "string" && entry[1] === true)
  );
}

function decisionThreadIsReady(
  decision: PlanDecisionRequest,
  selectedAnswers: Record<string, string>,
  resolvedThreads: Record<string, boolean>,
  savedAnswers: PlanDecisionAnswer[] = []
): boolean {
  return (
    Boolean(selectedAnswers[decision.id]?.trim()) ||
    resolvedThreads[decision.id] === true ||
    Boolean(decisionAnswerForDecision(decision, savedAnswers))
  );
}

function decisionThreadHasUserReply(decision: PlanDecisionRequest, replies: PlanDecisionReply[]): boolean {
  return replies.some((reply) => reply.decisionId === decision.id && reply.role === "user" && reply.content.trim());
}

function decisionThreadAnswer(
  decision: PlanDecisionRequest,
  selectedAnswers: Record<string, string>,
  replies: PlanDecisionReply[]
): string {
  const selectedOptionId = selectedAnswers[decision.id]?.trim();
  const selectedOption = decision.options.find((option) => option.id === selectedOptionId);
  const threadReplies = replies
    .filter((reply) => reply.decisionId === decision.id && reply.content.trim())
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  const lines = [
    `Decision: ${decision.title}`,
    `Question: ${decision.question}`,
    selectedOption ? `Selected option: ${selectedOption.label}` : "",
    "Thread transcript:",
    ...threadReplies.map((reply) => `${reply.role === "user" ? "User" : reply.participantLabel ?? "Participant"}: ${reply.content.trim()}`)
  ].filter(Boolean);
  return lines.join("\n");
}

function decisionAnswerForDecision(decision: PlanDecisionRequest, answers: PlanDecisionAnswer[]): PlanDecisionAnswer | undefined {
  return answers.find((answer) => answer.decisionId === decision.id);
}

function mergePlanDecisionAnswers(existing: PlanDecisionAnswer[], next: PlanDecisionAnswer[]): PlanDecisionAnswer[] {
  const merged = new Map<string, PlanDecisionAnswer>();
  for (const answer of [...existing, ...next]) {
    const key = answer.decisionId;
    if (key && answer.answer.trim()) {
      merged.set(key, answer);
    }
  }
  return Array.from(merged.values());
}

function planDecisionKey(decision: PlanDecisionRequest): string {
  return normalizeDecisionText(`${decision.title} ${decision.question}`).split(/\s+/).slice(0, 12).join(" ");
}

function planDecisionAnswerKey(answer: PlanDecisionAnswer): string {
  if (answer.decisionKey?.trim()) {
    return answer.decisionKey.trim();
  }
  const title = answer.answer.match(/^Decision:\s*(.+)$/m)?.[1] ?? "";
  const question = answer.answer.match(/^Question:\s*(.+)$/m)?.[1] ?? "";
  return title || question ? normalizeDecisionText(`${title} ${question}`).split(/\s+/).slice(0, 12).join(" ") : "";
}

function normalizeDecisionText(value: string): string {
  return value
    .toLowerCase()
    .replace(/`[^`]+`/g, "")
    .replace(/[^a-z0-9\s-]/gi, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !["critical", "high", "medium", "low", "info", "severity"].includes(word))
    .join(" ");
}

function healthLine(health: AgentHealth | undefined): string {
  if (!health) {
    return "Not checked";
  }
  if (!health.installed) {
    return "Not installed";
  }
  return health.version || health.path || "Installed";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function installDevMockBridge(): void {
  if (!import.meta.env.DEV || window.consensus || new URLSearchParams(window.location.search).get("mock") !== "chat-layout") {
    return;
  }

  const createdAt = new Date().toISOString();
  const longResponse = [
    "The deploy noise is consistent with the producer being initialized on first real TSCE traffic rather than during application startup.",
    "",
    "## Proposed Plan",
    "",
    "1. Add a startup warm-up path that initializes the Kafka producer before traffic is admitted.",
    "2. Run the warm-up from the application runner so it executes before readiness is advertised.",
    "3. Keep the direct TSCE gRPC fallback and failed-record persistence behavior unchanged.",
    "4. Add clear logging around warm-up success, timeout, and fallback activation.",
    "",
    "## Verification",
    "",
    ...Array.from({ length: 28 }, (_, index) =>
      `- Verification detail ${index + 1}: this line exists to keep the final chat message tall enough to require timeline scrolling while the composer remains visible at the bottom.`
    ),
    "",
    "The important UI condition is that this final paragraph remains fully reachable above the composer when the timeline is scrolled to the bottom."
  ].join("\n");
  const settings: AppSettings = {
    roundLimitDefault: 2,
    providers: [
      { kind: "codex-cli", label: "Codex CLI", enabled: true, model: "gpt-5.5" },
      { kind: "claude-code", label: "Claude Code", enabled: true, model: "sonnet" }
    ],
    chatRoleConfigs: [
      {
        id: "engineer",
        label: "Engineer",
        instructions: "Evaluate the request and propose concrete implementation steps.",
        version: 1,
        builtIn: true,
        updatedAt: createdAt
      }
    ],
    chatParticipantConfigs: [
      {
        id: "mock-codex-engineer",
        handle: "drew-codex-engineer",
        roleConfigId: "engineer",
        kind: "codex-cli",
        model: "gpt-5.5",
        updatedAt: createdAt
      },
      {
        id: "mock-claude-engineer",
        handle: "taylor-claude-engineer",
        roleConfigId: "engineer",
        kind: "claude-code",
        model: "sonnet",
        updatedAt: createdAt
      }
    ]
  };
  let sequence = 0;
  const nextId = (prefix: string): string => `${prefix}-${++sequence}`;
  let conversation: Conversation = {
    id: "mock-chat-layout",
    title: "Chat Layout Fixture",
    kind: "chat",
    repoPath: "/tmp/mock-repo",
    createdAt,
    updatedAt: createdAt,
    findings: [],
    metadata: {
      participants: [
        {
          id: "mock-user",
          handle: "user",
          roleConfigId: "engineer",
          kind: "codex-cli"
        },
        {
          id: "mock-codex-engineer",
          handle: "drew-codex-engineer",
          roleConfigId: "engineer",
          kind: "codex-cli",
          model: "gpt-5.5"
        },
        {
          id: "mock-claude-engineer",
          handle: "taylor-claude-engineer",
          roleConfigId: "engineer",
          kind: "claude-code",
          model: "sonnet"
        }
      ]
    },
    messages: [
      {
        id: "mock-start",
        role: "system",
        content: "Chat started.\\nParticipants:\\n\\n- User\\n- @drew-codex-engineer\\n- @taylor-claude-engineer",
        createdAt
      },
      {
        id: "mock-user-prompt",
        role: "user",
        content:
          "In the deploy logs from May 7, 2026, Viper starts successfully, then the first TSCE sends happen soon after traffic begins. @drew-codex-engineer @taylor-claude-engineer create plan how to fix",
        createdAt
      },
      {
        id: "mock-choice-response",
        role: "participant",
        participantId: "mock-codex-engineer",
        participantLabel: "@drew-codex-engineer",
        content: [
          "Before I write any session code I want a call from you on the token approach. There is no clean default here, just three trade-offs.",
          "Decision card below.",
          "",
          "User choice:",
          "T: Pick an auth token strategy",
          "Q: We need a token approach before I scaffold the session layer. Three credible options each shift revocability, infra cost, and complexity.",
          "O1: Session cookies (server-side) | Opaque IDs, state in Postgres. Easy to revoke per device, but every request hits the session store.",
          "O2: JWT access + refresh tokens | Stateless verify, refresh token rotates. Scales horizontally, but revocation needs a denylist.",
          "O3: Hybrid session + short JWT | Keeps fast auth checks while centralizing revocation, but adds coordination complexity.",
          "R: O2"
        ].join("\n"),
        createdAt,
        status: "done",
        metadata: {
          pendingChoice: {
            id: "mock-token-choice",
            title: "Pick an auth token strategy",
            question:
              "We need a token approach before I scaffold the session layer. Three credible options each shift revocability, infra cost, and complexity.",
            options: [
              {
                id: "O1",
                label: "Session cookies (server-side)",
                description: "Opaque IDs, state in Postgres. Easy to revoke per device, but every request hits the session store."
              },
              {
                id: "O2",
                label: "JWT access + refresh tokens",
                description: "Stateless verify, refresh token rotates. Scales horizontally, but revocation needs a denylist."
              },
              {
                id: "O3",
                label: "Hybrid session + short JWT",
                description: "Keeps fast auth checks while centralizing revocation, but adds coordination complexity."
              }
            ],
            recommendedOptionId: "O2",
            status: "pending"
          }
        }
      },
      {
        id: "mock-long-response",
        role: "participant",
        participantId: "mock-codex-engineer",
        participantLabel: "@drew-codex-engineer",
        content: longResponse,
        createdAt,
        status: "done"
      }
    ]
  };
  const conversationListeners = new Set<(updated: Conversation) => void>();
  const emitConversation = (): void => {
    const updated = { ...conversation, messages: [...conversation.messages], updatedAt: new Date().toISOString() };
    conversation = updated;
    conversationListeners.forEach((callback) => callback(updated));
  };
  const bridge: AppBridge = {
    getSettings: async () => settings,
    updateProviderSettings: async () => settings,
    saveChatRoleConfig: async () => settings,
    saveChatParticipantConfig: async () => settings,
    deleteChatParticipantConfig: async () => settings,
    updateLastRepoPath: async (repoPath) => ({ ...settings, lastRepoPath: repoPath }),
    listProviderModels: async () => [],
    detectAgents: async () => [
      { kind: "codex-cli", label: "Codex CLI", installed: true, version: "mock" },
      { kind: "claude-code", label: "Claude Code", installed: true, version: "mock" }
    ],
    selectRepoDirectory: async () => undefined,
    inspectRepo: async (repoPath) => ({ repoPath, isRepo: true, currentBranch: "mock", branches: ["mock"], statusLines: [] }),
    getDiff: async () => ({ mode: "working", title: "Mock diff", diff: "", metadata: {} }),
    listConversations: async () => [conversation],
    getConversation: async (id) => id === conversation.id ? conversation : undefined,
    saveDecisionSelections: async () => conversation,
    saveDecisionResolutions: async () => conversation,
    savePlanItemReview: async () => conversation,
    createChatConversation: async () => ({ conversation, warnings: [] }),
    addChatParticipant: async () => {
      emitConversation();
      return conversation;
    },
    sendChatMessage: async (request) => {
      const now = new Date().toISOString();
      conversation = {
        ...conversation,
        updatedAt: now,
        messages: [
          ...conversation.messages,
          { id: nextId("mock-user"), role: "user", content: request.content, createdAt: now },
          {
            id: nextId("mock-response"),
            role: "participant",
            participantId: "mock-claude-engineer",
            participantLabel: "@taylor-claude-engineer",
            content: longResponse,
            createdAt: now,
            status: "done"
          }
        ]
      };
      emitConversation();
      return { conversation, warnings: [] };
    },
    respondToChatMentions: async () => ({ conversation, warnings: [] }),
    respondToChatChoice: async (request) => {
      const now = new Date().toISOString();
      const source = conversation.messages.find((message) => message.id === request.sourceMessageId);
      const choice = source?.metadata?.pendingChoice;
      const selectedOption = choice?.options.find((option) => option.id === request.selectedOptionId);
      const customAnswer = request.customAnswer?.trim();
      const note = request.note?.trim();
      const isCustomAnswer = request.selectedOptionId === CHAT_CUSTOM_CHOICE_OPTION_ID;
      if (source && choice && (selectedOption || (isCustomAnswer && customAnswer))) {
        const selectedLabel = selectedOption?.label ?? customAnswer ?? "Write your own answer";
        source.metadata = {
          ...source.metadata,
          pendingChoice: {
            ...choice,
            status: "selected",
            selectedOptionId: selectedOption?.id ?? CHAT_CUSTOM_CHOICE_OPTION_ID,
            customAnswer: customAnswer || undefined,
            note: note || undefined,
            selectedAt: now
          }
        };
        conversation = {
          ...conversation,
          updatedAt: now,
          messages: [
            ...conversation.messages,
            {
              id: nextId("mock-choice-user"),
              role: "user",
              content: [
                "Choice selected for @drew-codex-engineer.",
                "",
                `Choice: ${choice.title}`,
                `Question: ${choice.question}`,
                selectedOption ? `Selected option: ${selectedOption.label}` : "Selected option: Write your own answer",
                customAnswer ? `Custom answer: ${customAnswer}` : "",
                note ? `Note: ${note}` : ""
              ].filter(Boolean).join("\n"),
              createdAt: now,
              metadata: {
                threadId: source.metadata?.threadId ?? source.id,
                parentMessageId: source.id,
                chatThreadRootId: source.id,
                sourceMessageId: source.id
              }
            },
            {
              id: nextId("mock-choice-response"),
              role: "participant",
              participantId: "mock-codex-engineer",
              participantLabel: "@drew-codex-engineer",
              content: `Proceeding with ${selectedLabel}. I will use that as the session-layer constraint.`,
              createdAt: now,
              status: "done",
              metadata: {
                threadId: source.metadata?.threadId ?? source.id,
                parentMessageId: source.id,
                chatThreadRootId: source.id,
                sourceMessageId: source.id,
                approvedContinuation: true
              }
            }
          ]
        };
      }
      emitConversation();
      return { conversation, warnings: [] };
    },
    startReview: async () => ({ conversation, warnings: [] }),
    continueReview: async () => ({ conversation, warnings: [] }),
    askPlanDecisionClarification: async () => ({ conversation, warnings: [] }),
    composeImplementationPlan: async () => ({ conversation, warnings: [] }),
    retryImplementationPlanSynthesis: async () => ({ conversation, warnings: [] }),
    recoverImplementationPlan: async () => ({ conversation, warnings: [] }),
    reviseImplementationPlan: async () => ({ conversation, warnings: [] }),
    cancelReview: async () => undefined,
    onReviewProgress: () => () => undefined,
    onConversationUpdated: (callback) => {
      conversationListeners.add(callback);
      return () => conversationListeners.delete(callback);
    }
  };
  window.consensus = bridge;
}

installDevMockBridge();

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <TooltipProvider>
        <App />
        <Toaster richColors position="bottom-right" />
      </TooltipProvider>
    </ThemeProvider>
  </React.StrictMode>
);
