import { useRef, useState } from "react";
import type {
  AgentHealth,
  AppSettings,
  ChatActivityItem,
  CloudRunRemoteExecutionMode,
  Conversation,
  ConversationKind,
  ConversationMessagePageInfo,
  ConversationSummary,
  GitRepoInfo,
  PlanDecisionReply,
  ReviewProgress
} from "../../shared/types";
import type { SettingsSection } from "../components/settings/settings-view";
import type { ChatMessageFocusRequest } from "../components/chat/chat-conversation-view";
import type { ChatParticipantDraft } from "../components/chat/chat-participant-drafts";
import { DEFAULT_SETTINGS } from "./constants";
import {
  persistChatSidebarWidth,
  persistSettingsSidebarWidth,
  readDismissedWarningsFromStorage,
  readActivityItemPreferencesFromStorage,
  readInitialAppSidebarWidths,
  readInitialSidebarCollapsed,
  readLastViewedAtFromStorage
} from "./storage";
import type { ActivityItemPreferences, DismissedWarningMap } from "./storage";

export type RailView = "chats" | "activity" | "settings";
export type StateSetter<T> = React.Dispatch<React.SetStateAction<T>>;

export interface AppState {
  settings: AppSettings;
  setSettings: StateSetter<AppSettings>;
  agents: AgentHealth[];
  setAgents: StateSetter<AgentHealth[]>;
  summaries: ConversationSummary[];
  setSummaries: StateSetter<ConversationSummary[]>;
  conversation: Conversation | undefined;
  setConversation: StateSetter<Conversation | undefined>;
  messagePage: ConversationMessagePageInfo | undefined;
  setMessagePage: StateSetter<ConversationMessagePageInfo | undefined>;
  olderMessagesLoading: boolean;
  setOlderMessagesLoading: StateSetter<boolean>;
  railView: RailView;
  setRailView: StateSetter<RailView>;
  activityItems: ChatActivityItem[];
  setActivityItems: StateSetter<ChatActivityItem[]>;
  activityLoading: boolean;
  setActivityLoading: StateSetter<boolean>;
  activityError: string | undefined;
  setActivityError: StateSetter<string | undefined>;
  activityFocusError: string | undefined;
  setActivityFocusError: StateSetter<string | undefined>;
  selectedActivityItem: ChatActivityItem | undefined;
  setSelectedActivityItem: StateSetter<ChatActivityItem | undefined>;
  activeSettingsSection: SettingsSection;
  setActiveSettingsSection: StateSetter<SettingsSection>;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: StateSetter<boolean>;
  sidebarWidth: number;
  setSidebarWidth: (width: number) => void;
  selectedThreadId: string | undefined;
  setSelectedThreadId: StateSetter<string | undefined>;
  focusedThreadId: string | undefined;
  setFocusedThreadId: StateSetter<string | undefined>;
  kind: ConversationKind;
  setKind: StateSetter<ConversationKind>;
  question: string;
  setQuestion: StateSetter<string>;
  repoPath: string;
  setRepoPath: StateSetter<string>;
  repoInfo: GitRepoInfo | undefined;
  setRepoInfo: StateSetter<GitRepoInfo | undefined>;
  warnings: string[];
  setWarnings: StateSetter<string[]>;
  dismissedWarningKeysByScope: DismissedWarningMap;
  setDismissedWarningKeysByScope: StateSetter<DismissedWarningMap>;
  initializing: boolean;
  setInitializing: StateSetter<boolean>;
  historyLoading: boolean;
  setHistoryLoading: StateSetter<boolean>;
  openingConversationId: string | undefined;
  setOpeningConversationId: StateSetter<string | undefined>;
  busy: boolean;
  setBusy: StateSetter<boolean>;
  currentRunId: string | undefined;
  setCurrentRunId: StateSetter<string | undefined>;
  progressLog: ReviewProgress[];
  setProgressLog: StateSetter<ReviewProgress[]>;
  decisionAnswers: Record<string, string>;
  setDecisionAnswers: StateSetter<Record<string, string>>;
  resolvedDecisionThreads: Record<string, boolean>;
  setResolvedDecisionThreads: StateSetter<Record<string, boolean>>;
  clarificationDrafts: Record<string, string>;
  setClarificationDrafts: StateSetter<Record<string, string>>;
  pendingClarifications: Record<string, PlanDecisionReply>;
  setPendingClarifications: StateSetter<Record<string, PlanDecisionReply>>;
  planItemReviewDrafts: Record<string, string>;
  setPlanItemReviewDrafts: StateSetter<Record<string, string>>;
  planCorrectionDraft: string;
  setPlanCorrectionDraft: StateSetter<string>;
  selectedChatParticipantConfigIds: Set<string>;
  setSelectedChatParticipantConfigIds: StateSetter<Set<string>>;
  selectedChatParticipantRunLocations: Record<string, CloudRunRemoteExecutionMode>;
  setSelectedChatParticipantRunLocations: StateSetter<Record<string, CloudRunRemoteExecutionMode>>;
  chatMessageDraft: string;
  setChatMessageDraft: StateSetter<string>;
  chatAddParticipantDraft: ChatParticipantDraft | undefined;
  setChatAddParticipantDraft: StateSetter<ChatParticipantDraft | undefined>;
  chatMessageFocusRequest: ChatMessageFocusRequest | undefined;
  setChatMessageFocusRequest: StateSetter<ChatMessageFocusRequest | undefined>;
  error: string | undefined;
  setError: StateSetter<string | undefined>;
  unreadConversationIds: Set<string>;
  setUnreadConversationIds: StateSetter<Set<string>>;
  progressLogRef: React.MutableRefObject<ReviewProgress[]>;
  openConversationRequestRef: React.MutableRefObject<number>;
  chatMessageFocusNonceRef: React.MutableRefObject<number>;
  activityRefreshRequestRef: React.MutableRefObject<number>;
  activityRevisionByConversationRef: React.MutableRefObject<Record<string, number>>;
  activityItemPreferencesRef: React.MutableRefObject<ActivityItemPreferences>;
  archivedConversationIdsRef: React.MutableRefObject<Set<string>>;
  lastViewedAtRef: React.MutableRefObject<Record<string, string>>;
  startingChatRef: React.MutableRefObject<boolean>;
  railViewRef: React.MutableRefObject<RailView>;
  selectedActivityConversationIdRef: React.MutableRefObject<string | undefined>;
}

export function useAppState(): AppState {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [agents, setAgents] = useState<AgentHealth[]>([]);
  const [summaries, setSummaries] = useState<ConversationSummary[]>([]);
  const [conversation, setConversation] = useState<Conversation | undefined>();
  const [messagePage, setMessagePage] = useState<ConversationMessagePageInfo | undefined>();
  const [olderMessagesLoading, setOlderMessagesLoading] = useState(false);
  const [railView, setRailView] = useState<RailView>("chats");
  const [activityItems, setActivityItems] = useState<ChatActivityItem[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState<string | undefined>();
  const [activityFocusError, setActivityFocusError] = useState<string | undefined>();
  const [selectedActivityItem, setSelectedActivityItem] = useState<ChatActivityItem | undefined>();
  const [activeSettingsSection, setActiveSettingsSection] = useState<SettingsSection>("general");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readInitialSidebarCollapsed);
  const [initialSidebarWidths] = useState(readInitialAppSidebarWidths);
  const [initialActivityItemPreferences] = useState(readActivityItemPreferencesFromStorage);
  const [chatSidebarWidth, setChatSidebarWidth] = useState(initialSidebarWidths.chats);
  const [settingsSidebarWidth, setSettingsSidebarWidth] = useState(initialSidebarWidths.settings);
  const [selectedThreadId, setSelectedThreadId] = useState<string | undefined>();
  const [focusedThreadId, setFocusedThreadId] = useState<string | undefined>();
  const [kind, setKind] = useState<ConversationKind>("chat");
  const [question, setQuestion] = useState("");
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
  const [decisionAnswers, setDecisionAnswers] = useState<Record<string, string>>({});
  const [resolvedDecisionThreads, setResolvedDecisionThreads] = useState<Record<string, boolean>>({});
  const [clarificationDrafts, setClarificationDrafts] = useState<Record<string, string>>({});
  const [pendingClarifications, setPendingClarifications] = useState<Record<string, PlanDecisionReply>>({});
  const [planItemReviewDrafts, setPlanItemReviewDrafts] = useState<Record<string, string>>({});
  const [planCorrectionDraft, setPlanCorrectionDraft] = useState("");
  const [selectedChatParticipantConfigIds, setSelectedChatParticipantConfigIds] = useState<Set<string>>(new Set());
  const [selectedChatParticipantRunLocations, setSelectedChatParticipantRunLocations] = useState<Record<string, CloudRunRemoteExecutionMode>>({});
  const [chatMessageDraft, setChatMessageDraft] = useState("");
  const [chatAddParticipantDraft, setChatAddParticipantDraft] = useState<ChatParticipantDraft | undefined>();
  const [chatMessageFocusRequest, setChatMessageFocusRequest] = useState<ChatMessageFocusRequest | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [unreadConversationIds, setUnreadConversationIds] = useState<Set<string>>(new Set());
  const progressLogRef = useRef<ReviewProgress[]>([]);
  const openConversationRequestRef = useRef(0);
  const chatMessageFocusNonceRef = useRef(0);
  const activityRefreshRequestRef = useRef(0);
  const activityRevisionByConversationRef = useRef<Record<string, number>>({});
  const activityItemPreferencesRef = useRef<ActivityItemPreferences>(initialActivityItemPreferences);
  const archivedConversationIdsRef = useRef<Set<string>>(new Set());
  const lastViewedAtRef = useRef<Record<string, string>>(readLastViewedAtFromStorage());
  const startingChatRef = useRef(false);
  // Latest-value refs so long-lived IPC subscriptions (which only re-subscribe on
  // currentRunId changes) can read the current view state without stale closures.
  const railViewRef = useRef<RailView>(railView);
  railViewRef.current = railView;
  const selectedActivityConversationIdRef = useRef<string | undefined>(selectedActivityItem?.conversationId);
  selectedActivityConversationIdRef.current = selectedActivityItem?.conversationId;
  const sidebarWidth = railView === "settings" ? settingsSidebarWidth : chatSidebarWidth;
  const setSidebarWidth = (width: number): void => {
    if (railView === "settings") {
      setSettingsSidebarWidth(width);
      persistSettingsSidebarWidth(width);
      return;
    }
    if (railView === "chats") {
      setChatSidebarWidth(width);
      persistChatSidebarWidth(width);
    }
  };

  return {
    settings, setSettings, agents, setAgents, summaries, setSummaries, conversation, setConversation,
    messagePage, setMessagePage, olderMessagesLoading, setOlderMessagesLoading, railView, setRailView,
    activityItems, setActivityItems, activityLoading, setActivityLoading, activityError, setActivityError,
    activityFocusError, setActivityFocusError,
    selectedActivityItem, setSelectedActivityItem,
    activeSettingsSection, setActiveSettingsSection, sidebarCollapsed, setSidebarCollapsed, sidebarWidth,
    setSidebarWidth, selectedThreadId, setSelectedThreadId, focusedThreadId, setFocusedThreadId, kind, setKind, question, setQuestion, repoPath,
    setRepoPath, repoInfo, setRepoInfo, warnings, setWarnings, dismissedWarningKeysByScope,
    setDismissedWarningKeysByScope, initializing, setInitializing, historyLoading, setHistoryLoading,
    openingConversationId, setOpeningConversationId, busy, setBusy, currentRunId, setCurrentRunId,
    progressLog, setProgressLog, decisionAnswers, setDecisionAnswers, resolvedDecisionThreads,
    setResolvedDecisionThreads, clarificationDrafts, setClarificationDrafts, pendingClarifications,
    setPendingClarifications, planItemReviewDrafts, setPlanItemReviewDrafts, planCorrectionDraft,
    setPlanCorrectionDraft, selectedChatParticipantConfigIds, setSelectedChatParticipantConfigIds,
    selectedChatParticipantRunLocations, setSelectedChatParticipantRunLocations,
    chatMessageDraft, setChatMessageDraft, chatAddParticipantDraft, setChatAddParticipantDraft,
    chatMessageFocusRequest, setChatMessageFocusRequest, error, setError, unreadConversationIds,
    setUnreadConversationIds, progressLogRef, openConversationRequestRef, chatMessageFocusNonceRef,
    activityRefreshRequestRef, activityRevisionByConversationRef, activityItemPreferencesRef, archivedConversationIdsRef,
    lastViewedAtRef, startingChatRef, railViewRef, selectedActivityConversationIdRef
  };
}
