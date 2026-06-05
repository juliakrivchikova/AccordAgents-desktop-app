import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Bot,
  Circle,
  ListChecks,
  PanelLeftOpen,
  RefreshCw,
  Settings,
  Users,
  X,
  XCircle
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import type {
  AgentHealth,
  AppSettings,
  ChatAppToolApprovalScope,
  ChatBehaviorRuleConfigUpdate,
  ChatImageInput,
  ChatParticipantConfig,
  ChatParticipantConfigUpdate,
  ChatRoleConfigUpdate,
  ChatSkillMention,
  Conversation,
  ConversationMessagePageInfo,
  ConversationKind,
  ConversationSummary,
  GitRepoInfo,
  PlanDecisionAnswer,
  PlanDecisionReply,
  ProviderSettings,
  RepoFileMention,
  ReviewProgress,
} from "../shared/types";
import { ModeToggle } from "./components/mode-toggle";
import { ThemeProvider } from "./components/theme-provider";
import { AppLoadingState } from "./components/loading-states";
import { AppShell, Sidebar, TopBar } from "./components/shell";
import type { ProjectSessionGroup } from "./components/shell";
import { SettingsView, type SettingsSection } from "./components/settings/settings-view";
import { SlackView } from "./components/review/review-view";
import { ChatConversationView } from "./components/chat/chat-conversation-view";
import { ChatParticipantMenu } from "./components/chat/chat-participant-menu";
import { ChatSetup } from "./components/chat/chat-setup-view";
import { ChatTopBarTitle } from "./components/chat/chat-top-bar-title";
import {
  chatParticipants,
  chatRoleLabel
} from "./components/chat/chat-conversation-data";
import { avatarForChatParticipant } from "./components/chat/chat-avatars";
import type { ChatParticipantDraft } from "./components/chat/chat-participant-drafts";
import {
  chatParticipantConfigToDraft,
  defaultChatParticipantDraft,
  normalizeChatParticipantDraftForSettings,
  normalizedChatDrafts,
  selectedChatParticipantDrafts,
  validateChatCliAgents,
  validateChatParticipantDrafts,
  validateChatStartupDrafts
} from "./components/chat/chat-participant-drafts";
import {
  IconButton,
  Notice
} from "./components/primitives";
import {
  Avatar
} from "./components/avatar/avatar";
import {
  canRecoverImplementationPlan,
  conversationMatchesSnapshot,
  conversationRelevantRunIds,
  decisionAnswerForDecision,
  decisionThreadAnswer,
  decisionThreadIsReady,
  displayNoticeText,
  errorText,
  firstPendingPlanItemReview,
  implementationPlanAnswers,
  labelForKind,
  mergePlanDecisionAnswers,
  mergePlanDecisionRequests,
  mergeProgressIntoConversation,
  pendingDecisionResolutions,
  pendingDecisionSelections,
  pendingPlanDecisions,
  pendingPlanItemReview,
  planDecisionKey,
  planDecisionReplies,
  planDecisionRequests,
  planItemReviewForFinding,
  planItemReviews,
  requiredPlanItemReviewFindings,
  threadExistsInConversation
} from "./components/review/review-conversation-data";
import {
  CONVERSATION_MESSAGE_PAGE_SIZE,
  fullConversationMessagePageInfo,
  mergeLoadedMessagePage,
  prependMissingMessages
} from "./lib/conversation-message-pages";
import "./styles/app.css";

const DEFAULT_SETTINGS: AppSettings = {
  roundLimitDefault: 2,
  providers: [],
  chatRoleConfigs: [],
  chatBehaviorRules: [],
  chatParticipantConfigs: []
};

const SIDEBAR_COLLAPSED_STORAGE_KEY = "accordagents.sidebarCollapsed";
const LAST_VIEWED_AT_STORAGE_KEY = "accordagents.lastViewedAt";
const DISMISSED_WARNINGS_STORAGE_KEY = "accordagents.dismissedWarnings.v1";
const GLOBAL_WARNING_DISMISS_SCOPE = "__global__";

type DismissedWarningMap = Record<string, string[]>;

interface WarningNoticeEntry {
  key: string;
  text: string;
}

function readLastViewedAtFromStorage(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(LAST_VIEWED_AT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const out: Record<string, string> = {};
      for (const [id, ts] of Object.entries(parsed)) {
        if (typeof ts === "string") out[id] = ts;
      }
      return out;
    }
  } catch {
    // ignore
  }
  return {};
}

function persistLastViewedAt(map: Record<string, string>): void {
  try {
    window.localStorage.setItem(LAST_VIEWED_AT_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

function readDismissedWarningsFromStorage(): DismissedWarningMap {
  try {
    const raw = window.localStorage.getItem(DISMISSED_WARNINGS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: DismissedWarningMap = {};
    for (const [scope, values] of Object.entries(parsed)) {
      if (typeof scope !== "string" || !Array.isArray(values)) {
        continue;
      }
      const warnings = values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
      if (warnings.length > 0) {
        out[scope] = Array.from(new Set(warnings));
      }
    }
    return out;
  } catch {
    return {};
  }
}

function persistDismissedWarnings(map: DismissedWarningMap): void {
  try {
    window.localStorage.setItem(DISMISSED_WARNINGS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

function warningDismissScope(conversation: Conversation | undefined): string {
  return conversation?.id ?? GLOBAL_WARNING_DISMISS_SCOPE;
}

function warningNoticeEntries(warnings: string[], dismissedKeys: Set<string>): WarningNoticeEntry[] {
  const seen = new Set<string>();
  const entries: WarningNoticeEntry[] = [];
  for (const warning of warnings) {
    const text = displayNoticeText(warning);
    if (!text || seen.has(text) || dismissedKeys.has(text)) {
      continue;
    }
    seen.add(text);
    entries.push({ key: text, text });
  }
  return entries;
}

function addDismissedWarningKeys(current: DismissedWarningMap, scope: string, keys: string[]): DismissedWarningMap {
  const additions = keys.filter(Boolean);
  if (additions.length === 0) {
    return current;
  }
  const existing = current[scope] ?? [];
  const merged = Array.from(new Set([...existing, ...additions]));
  if (merged.length === existing.length) {
    return current;
  }
  return { ...current, [scope]: merged };
}
type ActiveView = "slack" | "points" | "settings";
type ResultView = "slack" | "points";

function waitForNextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function readInitialSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

const NO_PROJECT_GROUP_KEY = "__no_project__";

function buildProjectSessionGroups(summaries: ConversationSummary[]): ProjectSessionGroup[] {
  const groups = new Map<string, ProjectSessionGroup>();

  for (const summary of summaries) {
    const projectPath = normalizeProjectPath(summary.repoPath);
    const key = projectPath ?? NO_PROJECT_GROUP_KEY;
    const existing = groups.get(key);
    if (existing) {
      existing.sessions.push(summary);
      if (conversationTimeValue(summary.updatedAt) > conversationTimeValue(existing.updatedAt)) {
        existing.updatedAt = summary.updatedAt;
      }
      continue;
    }
    groups.set(key, {
      key,
      label: projectPath ? projectLabelForPath(projectPath) : "No project",
      repoPath: projectPath,
      updatedAt: summary.updatedAt,
      sessions: [summary],
      isNoProject: !projectPath
    });
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      sessions: [...group.sessions].sort(compareConversationSummaries)
    }))
    .sort((left, right) => {
      if (left.isNoProject !== right.isNoProject) {
        return left.isNoProject ? 1 : -1;
      }
      const timeDelta = conversationTimeValue(right.updatedAt) - conversationTimeValue(left.updatedAt);
      return timeDelta || left.label.localeCompare(right.label);
    });
}

function normalizeProjectPath(repoPath: string | undefined): string | undefined {
  const trimmed = repoPath?.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.replace(/[\\/]+$/g, "");
  return normalized || trimmed;
}

function projectLabelForPath(repoPath: string): string {
  const parts = repoPath.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? repoPath;
}

function upsertConversationSummary(summaries: ConversationSummary[], conversation: Conversation): ConversationSummary[] {
  const nextSummary = summaryFromConversation(conversation);
  return [
    nextSummary,
    ...summaries.filter((summary) => summary.id !== conversation.id)
  ].sort(compareConversationSummaries);
}

function summaryFromConversation(conversation: Conversation): ConversationSummary {
  const activeRunIds = conversation.metadata?.activeRunIds;
  const hasActiveRuns = Array.isArray(activeRunIds) && activeRunIds.length > 0;
  const running = Boolean(hasActiveRuns || conversation.metadata?.running);
  return {
    id: conversation.id,
    title: conversation.title,
    kind: conversation.kind,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    repoPath: conversation.repoPath,
    running
  };
}

function compareConversationSummaries(left: ConversationSummary, right: ConversationSummary): number {
  const timeDelta = conversationTimeValue(right.updatedAt) - conversationTimeValue(left.updatedAt);
  return timeDelta || left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
}

function conversationTimeValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function App(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [agents, setAgents] = useState<AgentHealth[]>([]);
  const [summaries, setSummaries] = useState<ConversationSummary[]>([]);
  const [conversation, setConversation] = useState<Conversation | undefined>();
  const [messagePage, setMessagePage] = useState<ConversationMessagePageInfo | undefined>();
  const [olderMessagesLoading, setOlderMessagesLoading] = useState(false);
  const [activeView, setActiveView] = useState<ActiveView>("slack");
  const [activeSettingsSection, setActiveSettingsSection] = useState<SettingsSection>("local-clis");
  const [settingsReturnView, setSettingsReturnView] = useState<ResultView>("slack");
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readInitialSidebarCollapsed);
  const [selectedThreadId, setSelectedThreadId] = useState<string | undefined>();
  const [focusedThreadId, setFocusedThreadId] = useState<string | undefined>();
  const [kind, setKind] = useState<ConversationKind>("chat");
  const [question, setQuestion] = useState("Chat");
  const [repoPath, setRepoPath] = useState("");
  const [repoInfo, setRepoInfo] = useState<GitRepoInfo | undefined>();
  const [warnings, setWarnings] = useState<string[]>([]);
  const [dismissedWarningKeysByScope, setDismissedWarningKeysByScope] = useState<DismissedWarningMap>(readDismissedWarningsFromStorage);
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
  const [unreadConversationIds, setUnreadConversationIds] = useState<Set<string>>(new Set());
  const lastViewedAtRef = useRef<Record<string, string>>(readLastViewedAtFromStorage());

  useEffect(() => {
    void refreshAll();
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, sidebarCollapsed ? "true" : "false");
    } catch {
      // Local storage can be unavailable in restricted browser contexts.
    }
  }, [sidebarCollapsed]);

  useEffect(() => {
    return window.consensus.onReviewProgress((progress) => {
      setProgressLog((current) => {
        const appended = [...current, progress];
        // Keep last 500 entries across all runs to bound memory; concurrent runs each get
        // their own runId-tagged stream so downstream consumers filter by runId.
        const next = appended.length > 500 ? appended.slice(appended.length - 500) : appended;
        progressLogRef.current = next;
        return next;
      });
    });
  }, []);

  useEffect(() => {
    return window.consensus.onConversationUpdated((updated) => {
      setSummaries((current) => upsertConversationSummary(current, updated));
      setConversation((current) => {
        const isActive = current?.id === updated.id;
        if (!conversationMatchesSnapshot(current, updated, currentRunId)) {
          if (!isActive) {
            const lastViewed = lastViewedAtRef.current[updated.id];
            if (!lastViewed || conversationTimeValue(updated.updatedAt) > conversationTimeValue(lastViewed)) {
              setUnreadConversationIds((prev) => {
                if (prev.has(updated.id)) return prev;
                const next = new Set(prev);
                next.add(updated.id);
                return next;
              });
            }
          }
          return current;
        }
        setSelectedThreadId((selected) => (selected && !threadExistsInConversation(updated, selected) ? undefined : selected));
        setFocusedThreadId((focused) => (focused && !threadExistsInConversation(updated, focused) ? undefined : focused));
        const relevantRunIds = conversationRelevantRunIds(updated);
        const merged = mergeProgressIntoConversation(updated, progressLogRef.current.filter((item) => relevantRunIds.has(item.runId)));
        setMessagePage(fullConversationMessagePageInfo(merged));
        if (isActive) {
          lastViewedAtRef.current = { ...lastViewedAtRef.current, [updated.id]: merged.updatedAt };
          persistLastViewedAt(lastViewedAtRef.current);
        }
        return merged;
      });
    });
  }, [currentRunId]);

  useEffect(() => {
    if (!conversation || !messagePage?.hasMoreBefore || conversation.messages.length < messagePage.totalMessages) {
      return;
    }
    setMessagePage(fullConversationMessagePageInfo(conversation));
  }, [conversation?.id, conversation?.messages.length, messagePage?.hasMoreBefore, messagePage?.totalMessages]);

  useEffect(() => {
    setChatAddParticipantDraft((current) => normalizeChatParticipantDraftForSettings(current ?? defaultChatParticipantDraft(settings), settings));
  }, [settings]);

  useEffect(() => {
    const availableIds = new Set(settings.chatParticipantConfigs.map((participant) => participant.id));
    setSelectedChatParticipantConfigIds((current) => new Set([...current].filter((id) => availableIds.has(id))));
  }, [settings.chatParticipantConfigs]);

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
    if (conversation?.id !== id) {
      setWarnings([]);
    }
    if (conversation?.id === id) {
      setOpeningConversationId(undefined);
      setSettingsMenuOpen(false);
      setActiveView("slack");
      return;
    }
    setOpeningConversationId(id);
    try {
      await waitForNextFrame();
      const result = await window.consensus.openConversation(id, CONVERSATION_MESSAGE_PAGE_SIZE);
      if (requestId !== openConversationRequestRef.current) {
        return;
      }
      const next = result?.conversation;
      const nextPendingDecisions = pendingPlanDecisions(next);
      const nextPendingItem = firstPendingPlanItemReview(next);
      setConversation(next);
      setMessagePage(result?.messagePage);
      if (next) {
        setKind(next.kind);
        lastViewedAtRef.current = { ...lastViewedAtRef.current, [next.id]: next.updatedAt };
        persistLastViewedAt(lastViewedAtRef.current);
        setUnreadConversationIds((prev) => {
          if (!prev.has(next.id)) return prev;
          const ns = new Set(prev);
          ns.delete(next.id);
          return ns;
        });
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

  async function loadOlderConversationMessages(): Promise<void> {
    if (!conversation || !messagePage?.hasMoreBefore || olderMessagesLoading || messagePage.oldestSequence === undefined) {
      return;
    }
    const conversationId = conversation.id;
    setOlderMessagesLoading(true);
    setError(undefined);
    try {
      const page = await window.consensus.listConversationMessages({
        conversationId,
        beforeSequence: messagePage.oldestSequence,
        limit: CONVERSATION_MESSAGE_PAGE_SIZE
      });
      setConversation((current) => {
        if (!current || current.id !== conversationId) {
          return current;
        }
        return {
          ...current,
          messages: prependMissingMessages(current.messages, page.messages)
        };
      });
      setMessagePage((current) => mergeLoadedMessagePage(current, page));
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setOlderMessagesLoading(false);
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
    const validation = validateChatStartupDrafts(participants, settings.chatRoleConfigs, agents, settings.chatBehaviorRules);
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

  async function renameChatConversation(title: string): Promise<boolean> {
    if (!conversation || conversation.kind !== "chat") {
      return false;
    }
    const conversationId = conversation.id;
    setError(undefined);
    try {
      const saved = await window.consensus.renameChatConversation({ conversationId, title });
      if (!saved) {
        setError("Chat was not found.");
        return false;
      }
      setConversation((current) => (current?.id === conversationId ? saved : current));
      setSummaries((current) => upsertConversationSummary(current, saved));
      return true;
    } catch (caught) {
      setError(errorText(caught));
      return false;
    }
  }

  async function sendChatMessage(options: {
    content?: string;
    skillMentions?: ChatSkillMention[];
    repoFileMentions?: RepoFileMention[];
    imageAttachments?: ChatImageInput[];
    threadId?: string;
    parentMessageId?: string;
    chatThreadRootId?: string;
  } = {}): Promise<boolean> {
    if (!conversation || conversation.kind !== "chat") {
      return false;
    }
    const content = (options.content ?? chatMessageDraft).trim();
    const imageAttachments = options.imageAttachments ?? [];
    const skillMentions = options.skillMentions ?? [];
    if (!content && imageAttachments.length === 0 && skillMentions.length === 0) {
      setError("Enter a chat message or attach an image.");
      return false;
    }
    // A selected skill runs on a single participant (the main process enforces this too).
    // Block multi-mention sends here so the user gets an immediate message without a round-trip.
    if (skillMentions.length > 0) {
      const mentioned = chatParticipants(conversation).filter((participant) =>
        new RegExp(`@${participant.handle}(?![A-Za-z0-9_-])`).test(content)
      );
      if (mentioned.length > 1) {
        setError("A selected skill runs on a single participant. Mention exactly one participant, or remove the skill. Other participants can be brought in by the running skill itself.");
        return false;
      }
    }
    const runId = crypto.randomUUID();
    setError(undefined);
    setWarnings([]);
    if (!options.chatThreadRootId) {
      setChatMessageDraft("");
    }
    try {
      const result = await window.consensus.sendChatMessage({
        conversationId: conversation.id,
        runId,
        content,
        skillMentions,
        repoFileMentions: options.repoFileMentions,
        imageAttachments,
        threadId: options.threadId,
        parentMessageId: options.parentMessageId,
        chatThreadRootId: options.chatThreadRootId
      });
      const stillSameConversation = (current: Conversation | undefined): Conversation | undefined =>
        current && current.id === result.conversation.id
          ? mergeProgressIntoConversation(result.conversation, progressLogRef.current.filter((item) => item.runId === runId))
          : current;
      setConversation(stillSameConversation);
      if (result.warnings.length > 0) {
        setWarnings(result.warnings);
      }
      return true;
    } catch (caught) {
      const message = errorText(caught);
      if (message.toLowerCase().includes("cancel")) {
        setWarnings((current) => [...current, "Chat turn cancelled."]);
      } else {
        setError(message);
      }
      return false;
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

  async function toggleChatReaction(messageId: string, emoji: string): Promise<void> {
    if (!conversation || conversation.kind !== "chat") {
      return;
    }
    setError(undefined);
    try {
      const saved = await window.consensus.toggleChatReaction({
        conversationId: conversation.id,
        messageId,
        emoji
      });
      if (saved) {
        setConversation(saved);
        setSummaries((current) => upsertConversationSummary(current, saved));
      }
    } catch (caught) {
      setError(errorText(caught));
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

  async function commitChatParticipant(participant: ChatParticipantDraft): Promise<boolean> {
    if (!conversation || conversation.kind !== "chat") {
      return false;
    }
    const existingHandles = new Set(chatParticipants(conversation).map((item) => item.handle.toLowerCase()));
    const validation = validateChatParticipantDrafts([participant], settings.chatRoleConfigs, existingHandles, settings.chatBehaviorRules) ?? validateChatCliAgents([participant], agents);
    if (validation) {
      setError(validation);
      return false;
    }
    setError(undefined);
    try {
      const saved = await window.consensus.addChatParticipant({ conversationId: conversation.id, participant });
      if (saved) {
        setConversation(saved);
      }
      setSummaries(await window.consensus.listConversations());
      return true;
    } catch (caught) {
      setError(errorText(caught));
      return false;
    }
  }

  async function addChatParticipant(): Promise<void> {
    const draft = chatAddParticipantDraft ?? defaultChatParticipantDraft(settings);
    const participant = normalizedChatDrafts([draft])[0];
    const saved = await commitChatParticipant(participant);
    if (saved) {
      setChatAddParticipantDraft(defaultChatParticipantDraft(settings));
    }
  }

  async function addSavedChatParticipant(config: ChatParticipantConfig): Promise<void> {
    const participant = normalizedChatDrafts([chatParticipantConfigToDraft(config)])[0];
    await commitChatParticipant(participant);
  }

  async function respondToChatAppToolApproval(approvalId: string, approve: boolean, scope?: ChatAppToolApprovalScope): Promise<void> {
    if (!conversation || conversation.kind !== "chat") {
      return;
    }
    setError(undefined);
    try {
      const saved = await window.consensus.respondToChatAppToolApproval({
        conversationId: conversation.id,
        approvalId,
        approve,
        scope
      });
      if (saved) {
        setConversation(saved);
      }
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
    setMessagePage(undefined);
    setOlderMessagesLoading(false);
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
    setKind("chat");
    setQuestion("Chat");
    setError(undefined);
    setSettingsMenuOpen(false);
    setActiveView("slack");
  }

  async function newProjectSession(projectRepoPath?: string): Promise<void> {
    if (busy) {
      return;
    }
    const nextRepoPath = normalizeProjectPath(projectRepoPath) ?? "";
    newReview();
    setRepoPath(nextRepoPath);
    setRepoInfo(undefined);
    if (nextRepoPath) {
      await inspectRepo(nextRepoPath);
    }
  }

  async function updateProvider(provider: ProviderSettings, patch: { enabled?: boolean; model?: string; apiKey?: string; clearApiKey?: boolean }): Promise<void> {
    setError(undefined);
    try {
      const next = await window.consensus.updateProviderSettings({ kind: provider.kind, ...patch });
      setSettings(next);
    } catch (caught) {
      setError(errorText(caught));
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

  async function saveChatBehaviorRuleConfig(update: ChatBehaviorRuleConfigUpdate): Promise<void> {
    setError(undefined);
    try {
      const next = await window.consensus.saveChatBehaviorRuleConfig(update);
      setSettings(next);
    } catch (caught) {
      setError(errorText(caught));
    }
  }

  async function deleteChatBehaviorRuleConfig(id: string): Promise<void> {
    setError(undefined);
    try {
      const next = await window.consensus.deleteChatBehaviorRuleConfig(id);
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
  const conversationRunning = busy || Boolean(conversation?.metadata.running);
  const conversationMetadataWarnings = Array.isArray(conversation?.metadata?.warnings)
    ? (conversation!.metadata.warnings as unknown[]).filter((w): w is string => typeof w === "string")
    : [];
  const warningScope = warningDismissScope(conversation);
  const dismissedWarningKeys = new Set(dismissedWarningKeysByScope[warningScope] ?? []);
  const visibleWarnings = warningNoticeEntries([...warnings, ...conversationMetadataWarnings], dismissedWarningKeys);
  const chatSummaries = useMemo(() => summaries.filter((summary) => summary.kind === "chat"), [summaries]);
  const projectSessionGroups = useMemo(() => buildProjectSessionGroups(chatSummaries), [chatSummaries]);
  const activeChatConversation = activeView !== "settings" && conversation?.kind === "chat" ? conversation : undefined;
  const activeChatParticipants = useMemo(() => activeChatConversation ? chatParticipants(activeChatConversation) : [], [activeChatConversation]);
  const topBarTitle = activeView === "settings"
    ? undefined
    : activeChatConversation
      ? (
        <ChatTopBarTitle
          conversation={activeChatConversation}
          isRunning={conversationRunning}
          onRenameTitle={renameChatConversation}
        />
      )
    : hasResultContext
      ? conversation?.title ?? openingConversation?.title ?? "Chat"
      : "New chat";
  const openSettingsSection = (section: SettingsSection): void => {
    if (activeView !== "settings") {
      setSettingsReturnView(activeView === "points" ? "points" : "slack");
    }
    setActiveSettingsSection(section);
    setActiveView("settings");
    setSettingsMenuOpen(false);
  };
  const closeSettings = (): void => {
    setActiveView(settingsReturnView);
  };
  const dismissWarnings = (keys: string[]): void => {
    setDismissedWarningKeysByScope((current) => {
      const next = addDismissedWarningKeys(current, warningScope, keys);
      if (next !== current) {
        persistDismissedWarnings(next);
      }
      return next;
    });
  };
  const dismissWarning = (key: string): void => {
    dismissWarnings([key]);
  };
  const dismissVisibleWarnings = (): void => {
    dismissWarnings(visibleWarnings.map((warning) => warning.key));
  };

  const topBarLeading = sidebarCollapsed ? (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      title="Show sidebar"
      aria-label="Show sidebar"
      aria-controls="app-sidebar"
      aria-expanded="false"
      data-testid="sidebar-expand-toggle"
      onClick={() => setSidebarCollapsed(false)}
    >
      <PanelLeftOpen aria-hidden />
      <span className="sr-only">Show sidebar</span>
    </Button>
  ) : undefined;

  const topBarActions = (
    <>
      {busy && (
        <Button variant="outline" size="sm" onClick={() => void cancelReview()}>
          <XCircle aria-hidden />
          Stop
        </Button>
      )}
      {activeChatConversation && (
        <ChatParticipantMenu
          participants={activeChatParticipants}
          settings={settings}
          agents={agents}
          draft={chatMessageDraft}
          addParticipantDraft={chatAddParticipantDraft ?? defaultChatParticipantDraft(settings)}
          isRunning={conversationRunning}
          onDraftChange={setChatMessageDraft}
          onAddParticipantDraftChange={setChatAddParticipantDraft}
          onAddParticipant={() => void addChatParticipant()}
          onAddSavedParticipant={(participant) => void addSavedChatParticipant(participant)}
        />
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
                openSettingsSection("local-clis");
              }}
            >
              <Bot aria-hidden />
              Local CLIs
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
                openSettingsSection("behavior-rules");
              }}
            >
              <ListChecks aria-hidden />
              Rules
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
      sidebarCollapsed={sidebarCollapsed}
      sidebar={
        <Sidebar
          projectGroups={projectSessionGroups}
          activeId={conversation?.id}
          pendingId={openingConversationId}
          busy={busy}
          loading={historyLoading}
          unreadIds={unreadConversationIds}
          onSelect={(id) => void openConversation(id)}
          onNewSession={newReview}
          onNewProjectSession={(projectRepoPath) => void newProjectSession(projectRepoPath)}
          onToggleSidebar={() => setSidebarCollapsed(true)}
        />
      }
      topBar={
        <TopBar leading={topBarLeading} title={topBarTitle} actions={topBarActions} />
      }
    >

        {error && (
          <div className="mx-3 mt-2">
            <Notice tone="error">{displayNoticeText(error)}</Notice>
          </div>
        )}
        {visibleWarnings.length > 0 && (
          <div className="mx-3 mt-2 space-y-2">
            {visibleWarnings.length > 1 && (
              <div className="flex justify-end">
                <Button type="button" variant="ghost" size="xs" onClick={dismissVisibleWarnings}>
                  Dismiss all
                </Button>
              </div>
            )}
            {visibleWarnings.map((warning) => (
              <Notice
                tone="warning"
                key={warning.key}
                action={
                  <IconButton
                    label="Dismiss warning"
                    icon={X}
                    size="xs"
                    tooltip="Dismiss warning"
                    onClick={() => dismissWarning(warning.key)}
                  />
                }
              >
                {warning.text}
              </Notice>
            ))}
          </div>
        )}

        {activeView === "settings" ? (
          <SettingsView
            section={activeSettingsSection}
            settings={settings}
            agents={agents}
            updateProvider={updateProvider}
            saveChatRoleConfig={saveChatRoleConfig}
            saveChatBehaviorRuleConfig={saveChatBehaviorRuleConfig}
            deleteChatBehaviorRuleConfig={deleteChatBehaviorRuleConfig}
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
                <ChatSetup
                  title={question}
                  repoPath={repoPath}
                  repoInfo={repoInfo}
                  selectedParticipantIds={selectedChatParticipantConfigIds}
                  settings={settings}
                  agents={agents}
                  busy={busy}
                  renderParticipantAvatar={(participant) => <Avatar className="mini-avatar" spec={avatarForChatParticipant(participant)} />}
                  participantRoleLabel={(participant) => chatRoleLabel(settings.chatRoleConfigs, participant)}
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
                    progress={progressLog}
                    isRunning={conversationRunning}
                    hasOlderMessages={Boolean(messagePage?.hasMoreBefore)}
                    olderMessagesLoading={olderMessagesLoading}
                    draft={chatMessageDraft}
                    onDraftChange={setChatMessageDraft}
                    onLoadOlderMessages={() => void loadOlderConversationMessages()}
                    onSend={(repoFileMentions, imageAttachments, skillMentions) => sendChatMessage({ repoFileMentions, imageAttachments, skillMentions })}
                    onSendThread={(rootMessage, content, repoFileMentions, imageAttachments, skillMentions) => sendChatMessage({
                      content,
                      skillMentions,
                      repoFileMentions,
                      imageAttachments,
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
                    onToggleReaction={(messageId, emoji) => void toggleChatReaction(messageId, emoji)}
                    onRespondToAppToolApproval={respondToChatAppToolApproval}
                    onStopRun={(runId) => void window.consensus.cancelReview(runId)}
                  />
                ) : (
                  <SlackView
                    conversation={conversation}
                    progress={progressLog}
                    kind={conversationKind}
                    isRunning={conversationRunning}
                    hasOlderMessages={Boolean(messagePage?.hasMoreBefore)}
                    olderMessagesLoading={olderMessagesLoading}
                    onLoadOlderMessages={() => void loadOlderConversationMessages()}
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
              </section>
            )}
          </div>
        )}
    </AppShell>
  );
}

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
