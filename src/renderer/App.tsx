import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Circle,
  FolderOpen,
  GitPullRequest,
  HelpCircle,
  KeyRound,
  ListChecks,
  MessageSquare,
  Play,
  RefreshCw,
  Settings,
  XCircle
} from "lucide-react";
import type {
  AgentHealth,
  AppSettings,
  Conversation,
  ConversationKind,
  ConversationSummary,
  Finding,
  FindingSeverity,
  FindingStatus,
  GitDiffMode,
  GitRepoInfo,
  ParticipantConfig,
  ProviderKind,
  ProviderModel,
  ProviderSettings,
  ReviewProgress
} from "../shared/types";
import "./styles/app.css";

const DEFAULT_SETTINGS: AppSettings = {
  roundLimitDefault: 2,
  providers: []
};

const DIFF_MODES: Array<{ value: GitDiffMode; label: string }> = [
  { value: "uncommitted", label: "Uncommitted" },
  { value: "working", label: "Unstaged" },
  { value: "staged", label: "Staged" },
  { value: "base", label: "Branches" },
  { value: "commit", label: "Commit" },
  { value: "pasted", label: "Pasted diff" }
];

const BRANCH_COMPARE_HELP = "Changes committed on the compare branch since it diverged from the base branch.";

const POINT_SEVERITIES: FindingSeverity[] = ["Critical", "High", "Medium", "Low"];

function providerId(provider: ProviderSettings): string {
  return provider.kind;
}

function isCli(kind: ProviderKind): boolean {
  return kind === "codex-cli" || kind === "claude-code";
}

function App(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [agents, setAgents] = useState<AgentHealth[]>([]);
  const [summaries, setSummaries] = useState<ConversationSummary[]>([]);
  const [conversation, setConversation] = useState<Conversation | undefined>();
  const [activeView, setActiveView] = useState<"slack" | "points" | "settings">("slack");
  const [selectedThreadId, setSelectedThreadId] = useState<string | undefined>();
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
  const [busy, setBusy] = useState(false);
  const [currentRunId, setCurrentRunId] = useState<string | undefined>();
  const [progressLog, setProgressLog] = useState<ReviewProgress[]>([]);
  const progressLogRef = useRef<ReviewProgress[]>([]);
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
    setSelectedParticipants(new Set(settings.providers.filter((provider) => provider.enabled).map(providerId)));
  }, [settings.providers]);

  useEffect(() => {
    const firstRunnable = settings.providers.find((provider) => !providerDisabledForRun(provider));
    if ((!selectedArbiterId || !settings.providers.some((provider) => providerId(provider) === selectedArbiterId)) && firstRunnable) {
      setSelectedArbiterId(providerId(firstRunnable));
    }
  }, [agents, kind, repoPath, selectedArbiterId, settings.providers]);

  const participantOptions = useMemo(() => {
    return settings.providers.map((provider) => {
      const health = agents.find((agent) => agent.kind === provider.kind);
      const cliWithoutRepo = isCli(provider.kind) && kind === "code-review" && !repoPath.trim();
      return {
        provider,
        disabled: providerDisabledForRun(provider),
        health,
        disabledReason: cliWithoutRepo
          ? "Local CLI agents need a selected repo for code review"
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

  async function refreshAll(): Promise<void> {
    setError(undefined);
    try {
      const [nextSettings, nextAgents, nextSummaries] = await Promise.all([
        window.consensus.getSettings(),
        window.consensus.detectAgents(),
        window.consensus.listConversations()
      ]);
      setSettings(nextSettings);
      setAgents(nextAgents);
      setSummaries(nextSummaries);
    } catch (caught) {
      setError(errorText(caught));
    }
  }

  async function openConversation(id: string): Promise<void> {
    setError(undefined);
    try {
      const next = await window.consensus.getConversation(id);
      setConversation(next);
      progressLogRef.current = [];
      setProgressLog([]);
      setSelectedThreadId(undefined);
      setActiveView("slack");
    } catch (caught) {
      setError(errorText(caught));
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

  async function inspectRepo(path: string = repoPath): Promise<void> {
    if (!path.trim()) {
      return;
    }
    setError(undefined);
    try {
      const info = await window.consensus.inspectRepo(path.trim());
      setRepoInfo(info);
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
      setError("Select an arbiter.");
      return;
    }
    const participants = buildParticipants();
    if (participants.length === 0) {
      setError("Select at least one participant.");
      return;
    }
    if (kind === "code-review" && diffMode !== "pasted" && !repoPath.trim()) {
      setError("Select a local repository first.");
      return;
    }

    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    setCurrentRunId(runId);
    progressLogRef.current = [];
    setProgressLog([]);
    setSelectedThreadId(undefined);
    setActiveView("slack");
    setConversation({
      id: runId,
      title: question.trim().slice(0, 80) || "Consensus review",
      kind,
      createdAt: startedAt,
      updatedAt: startedAt,
      repoPath: repoPath.trim() || undefined,
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
        repoPath: repoPath.trim() || undefined,
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

  function newReview(): void {
    if (busy) {
      return;
    }
    setConversation(undefined);
    progressLogRef.current = [];
    setProgressLog([]);
    setSelectedThreadId(undefined);
    setWarnings([]);
    setError(undefined);
    setActiveView("slack");
  }

  function buildParticipants(): ParticipantConfig[] {
    return settings.providers
      .filter((provider) => selectedParticipants.has(providerId(provider)))
      .filter((provider) => !providerDisabledForRun(provider))
      .filter((provider) => !(isCli(provider.kind) && kind === "code-review" && !repoPath.trim()))
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
    if (isCli(provider.kind)) {
      return !health?.installed || (kind === "code-review" && !repoPath.trim());
    }
    return !provider.hasApiKey;
  }

  function toggleParticipant(provider: ProviderSettings): void {
    if (isCli(provider.kind) && kind === "code-review" && !repoPath.trim()) {
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

  const hasResultContext = Boolean(conversation) || busy;
  const resultView = activeView === "points" ? "points" : "slack";
  const hasPoints = Boolean(conversation && conversation.metadata.running !== true);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <Bot size={22} />
          <span>AI Consensus</span>
        </div>
        <button className="new-button" disabled={busy} onClick={newReview}>
          <MessageSquare size={16} />
          New review
        </button>
        <div className="sidebar-section-title">History</div>
        <div className="history-list">
          {summaries.map((summary) => (
            <button
              key={summary.id}
              className={`history-item ${conversation?.id === summary.id ? "active" : ""}`}
              onClick={() => void openConversation(summary.id)}
            >
              <span>{summary.title}</span>
              <small>{summary.kind === "code-review" ? "Code review" : "Question"}</small>
            </button>
          ))}
          {summaries.length === 0 && <div className="empty-history">No conversations yet</div>}
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          {hasResultContext ? (
            <div className="tabs" role="tablist">
              <button className={resultView === "slack" && activeView !== "settings" ? "selected" : ""} onClick={() => setActiveView("slack")}>
                <MessageSquare size={15} />
                Slack
              </button>
              {hasPoints && (
                <button className={resultView === "points" && activeView !== "settings" ? "selected" : ""} onClick={() => setActiveView("points")}>
                  <ListChecks size={15} />
                  Points
                </button>
              )}
            </div>
          ) : (
            <div className="topbar-title">New review</div>
          )}
          <div className="topbar-actions">
            {busy && (
              <button className="stop-button" onClick={() => void cancelReview()}>
                <XCircle size={17} />
                Stop
              </button>
            )}
            <button className={`icon-button ${activeView === "settings" ? "selected" : ""}`} title="Settings" onClick={() => setActiveView("settings")}>
              <Settings size={15} />
            </button>
            <button className="icon-button" title="Refresh" onClick={() => void refreshAll()}>
              <RefreshCw size={17} />
            </button>
          </div>
        </header>

        {error && (
          <div className="notice error">
            <AlertTriangle size={17} />
            {error}
          </div>
        )}
        {warnings.map((warning) => (
          <div className="notice" key={warning}>
            <AlertTriangle size={17} />
            {warning}
          </div>
        ))}

        {activeView === "settings" ? (
          <SettingsView
            settings={settings}
            agents={agents}
            apiKeyDrafts={apiKeyDrafts}
            providerModels={providerModels}
            modelLoading={modelLoading}
            modelErrors={modelErrors}
            setApiKeyDrafts={setApiKeyDrafts}
            updateProvider={updateProvider}
            refreshProviderModels={refreshProviderModels}
          />
        ) : (
          <div className={`content-area ${hasResultContext ? "result-layout" : "compose-layout"}`}>
            {!hasResultContext && (
            <section className="composer">
              <div className="segmented">
                <button className={kind === "code-review" ? "selected" : ""} onClick={() => setKind("code-review")}>
                  <GitPullRequest size={15} />
                  Code review
                </button>
                <button className={kind === "general" ? "selected" : ""} onClick={() => setKind("general")}>
                  <MessageSquare size={15} />
                  Question
                </button>
              </div>

              <label className="field">
                <span>Prompt</span>
                <textarea value={question} onChange={(event) => setQuestion(event.target.value)} rows={5} />
              </label>

              {kind === "code-review" && (
                <>
                  <div className="repo-row">
                    <label className="field grow">
                      <span>Repository</span>
                      <input
                        value={repoPath}
                        onChange={(event) => {
                          setRepoPath(event.target.value);
                          setRepoInfo(undefined);
                        }}
                        onBlur={() => void inspectRepo()}
                      />
                    </label>
                    <button className="tool-button" onClick={() => void selectRepo()} title="Select repository">
                      <FolderOpen size={17} />
                    </button>
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

                  <div className="field">
                    <span>Diff mode</span>
                    <div className="diff-mode-grid">
                      {DIFF_MODES.map((mode) => (
                        <button
                          key={mode.value}
                          className={diffMode === mode.value ? "selected" : ""}
                          onClick={() => setDiffMode(mode.value)}
                        >
                          {mode.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {diffMode === "base" && (
                    <div className="field">
                      <span>Branches</span>
                      <div className="branch-compare-row">
                        <label className="branch-select">
                          <span>Base branch</span>
                          <select
                            value={selectedBaseBranch}
                            onChange={(event) => setBaseBranch(event.target.value)}
                            aria-describedby="branch-compare-help"
                            disabled={branchSelectDisabled}
                            title={BRANCH_COMPARE_HELP}
                          >
                            <option value="" disabled>
                              {branchSelectPlaceholder}
                            </option>
                            {branchOptions.map((branch) => (
                              <option key={branch} value={branch}>
                                {branch}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="branch-select">
                          <span>Compare branch</span>
                          <select
                            value={selectedCompareBranch}
                            onChange={(event) => setCompareBranch(event.target.value)}
                            aria-describedby="branch-compare-help"
                            disabled={branchSelectDisabled}
                            title={BRANCH_COMPARE_HELP}
                          >
                            <option value="" disabled>
                              {branchSelectPlaceholder}
                            </option>
                            {branchOptions.map((branch) => (
                              <option key={branch} value={branch}>
                                {branch}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <div className="inline-hint" id="branch-compare-help">
                        {BRANCH_COMPARE_HELP}
                      </div>
                    </div>
                  )}
                  {diffMode === "commit" && (
                    <label className="field">
                      <span>Commit SHA</span>
                      <input value={commit} onChange={(event) => setCommit(event.target.value)} />
                    </label>
                  )}
                  {diffMode === "pasted" && (
                    <label className="field">
                      <span>Pasted diff</span>
                      <textarea value={pastedDiff} onChange={(event) => setPastedDiff(event.target.value)} rows={7} />
                    </label>
                  )}

                  <button className="secondary-button" onClick={() => void previewDiff()}>
                    Preview diff
                  </button>
                  {diffPreview && <pre className="diff-preview">{diffPreview.slice(0, 6000)}</pre>}
                </>
              )}

              <div className="participant-picker">
                <span>Participants</span>
                {participantOptions.map(({ provider, disabled, health, disabledReason }) => (
                  <button
                    key={provider.kind}
                    className={`participant-pill ${selectedParticipants.has(providerId(provider)) ? "selected" : ""}`}
                    disabled={disabled}
                    onClick={() => toggleParticipant(provider)}
                    title={disabledReason ?? provider.model ?? provider.label}
                  >
                    {selectedParticipants.has(providerId(provider)) ? <CheckCircle2 size={15} /> : <Circle size={15} />}
                    {provider.label}
                    {providerId(provider) === selectedArbiterId && (
                      <small>{selectedParticipants.has(providerId(provider)) ? "also arbiter" : "arbiter only"}</small>
                    )}
                    {isCli(provider.kind) && <small>{health?.installed ? "local" : "missing"}</small>}
                  </button>
                ))}
              </div>

              <label className="field">
                <span>Arbiter</span>
                <select value={selectedArbiterId} onChange={(event) => setSelectedArbiterId(event.target.value)}>
                  {participantOptions.map(({ provider, disabled, disabledReason }) => (
                    <option key={provider.kind} value={providerId(provider)} disabled={disabled}>
                      {provider.label}{disabledReason ? ` - ${disabledReason}` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <div className="inline-hint">The arbiter merge is a separate run. If the same provider is selected as a participant, it also gets an independent participant run.</div>

              <button className="run-button" disabled={busy} onClick={() => void startReview()}>
                {busy ? <RefreshCw size={17} className="spin" /> : <Play size={17} />}
                {busy ? "Running consensus..." : "Start consensus"}
              </button>
            </section>
            )}

            {hasResultContext && (
              <section className="conversation-panel">
                {resultView === "slack" && (
                  <SlackView
                    conversation={conversation}
                    progress={progressLog}
                    kind={conversation?.kind ?? kind}
                    isRunning={busy}
                    selectedThreadId={selectedThreadId}
                    onSelectThread={setSelectedThreadId}
                  />
                )}
                {resultView === "points" && <PointsView conversation={conversation} kind={conversation?.kind ?? kind} />}
              </section>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function SettingsView(props: {
  settings: AppSettings;
  agents: AgentHealth[];
  apiKeyDrafts: Record<string, string>;
  providerModels: Record<string, ProviderModel[]>;
  modelLoading: Record<string, boolean>;
  modelErrors: Record<string, string | undefined>;
  setApiKeyDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  updateProvider: (provider: ProviderSettings, patch: { enabled?: boolean; model?: string; apiKey?: string; clearApiKey?: boolean }) => Promise<void>;
  refreshProviderModels: (kind: ProviderKind) => Promise<void>;
}): JSX.Element {
  return (
    <section className="settings-view">
      <h1>Settings</h1>
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
                  <div className="model-row">
                    <label className="field grow">
                      <span>Model</span>
                      {models.length > 0 ? (
                        <select
                          value={models.some((model) => model.id === provider.model) ? provider.model : "__custom__"}
                          onChange={(event) => {
                            if (event.target.value !== "__custom__") {
                              void props.updateProvider(provider, { model: event.target.value });
                            }
                          }}
                        >
                          {models.map((model) => (
                            <option key={model.id} value={model.id}>
                              {model.label}
                            </option>
                          ))}
                          <option value="__custom__">Custom model ID...</option>
                        </select>
                      ) : (
                        <input
                          value={provider.model ?? ""}
                          onChange={(event) => void props.updateProvider(provider, { model: event.target.value })}
                          placeholder={provider.hasApiKey ? "Fetch models or enter a custom model id" : "Save an API key first"}
                        />
                      )}
                    </label>
                    <button
                      className="tool-button"
                      title="Fetch available models"
                      disabled={!provider.hasApiKey || isLoadingModels}
                      onClick={() => void props.refreshProviderModels(provider.kind)}
                    >
                      <RefreshCw size={17} className={isLoadingModels ? "spin" : ""} />
                    </button>
                  </div>
                  {models.length > 0 && !models.some((model) => model.id === provider.model) && (
                    <label className="field compact-field">
                      <span>Custom model ID</span>
                      <input
                        value={provider.model ?? ""}
                        onChange={(event) => void props.updateProvider(provider, { model: event.target.value })}
                      />
                    </label>
                  )}
                  {modelError && <div className="inline-error">{modelError}</div>}
                  <div className="key-row">
                    <label className="field grow">
                      <span>API key</span>
                      <input
                        type="password"
                        value={props.apiKeyDrafts[provider.kind] ?? ""}
                        onChange={(event) =>
                          props.setApiKeyDrafts((current) => ({ ...current, [provider.kind]: event.target.value }))
                        }
                      />
                    </label>
                    <button
                      className="save-key-button"
                      title="Save API key"
                      disabled={!hasDraftKey}
                      onClick={() => void props.updateProvider(provider, { apiKey: props.apiKeyDrafts[provider.kind] ?? "" })}
                    >
                      <KeyRound size={17} />
                      Save key
                    </button>
                  </div>
                  {hasDraftKey && <div className="inline-warning">Unsaved API key entered.</div>}
                  {provider.hasApiKey && (
                    <button className="secondary-button" onClick={() => void props.updateProvider(provider, { clearApiKey: true })}>
                      Clear saved key
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

type TimelineItem =
  | { id: string; type: "message"; createdAt: string; message: Conversation["messages"][number] }
  | { id: string; type: "finding"; createdAt: string; finding: Finding };

function SlackView(props: {
  conversation?: Conversation;
  progress: ReviewProgress[];
  kind: ConversationKind;
  isRunning: boolean;
  selectedThreadId?: string;
  onSelectThread: (id: string | undefined) => void;
}): JSX.Element {
  const { conversation, progress, kind, isRunning, selectedThreadId, onSelectThread } = props;

  if (!conversation) {
    return <EmptyState title="No conversation selected" body="Start a new review or choose a previous conversation." />;
  }

  const showLiveProgress = isRunning && conversation.metadata.running === true;
  const liveProgressMessages = showLiveProgress ? progress.map(progressToMessage) : [];
  const messageItems: TimelineItem[] = [...conversation.messages.filter((message) => message.role !== "summary"), ...liveProgressMessages].map(
    (message) => ({
      id: message.id,
      type: "message",
      createdAt: message.createdAt,
      message
    })
  );
  const findingItems: TimelineItem[] = conversation.findings.map((finding) => ({
    id: finding.id,
    type: "finding",
    createdAt: finding.createdAt ?? conversation.updatedAt,
    finding
  }));
  const items = [...messageItems, ...findingItems].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  const selectedFinding = conversation.findings.find((finding) => finding.id === selectedThreadId);

  return (
    <div className="slack-view">
      <section className="slack-timeline" aria-label="Consensus timeline">
        <div className="view-heading">
          <h2>{kind === "code-review" ? "Review Timeline" : "Consensus Timeline"}</h2>
          <span>{showLiveProgress ? "Running" : `${conversation.findings.length} points`}</span>
        </div>
        {items.map((item) =>
          item.type === "message" ? (
            <TimelineMessage message={item.message} key={item.id} />
          ) : (
            <PointTimelineMessage
              finding={item.finding}
              selected={item.finding.id === selectedThreadId}
              onSelect={() => onSelectThread(item.finding.id)}
              key={item.id}
            />
          )
        )}
        {showLiveProgress && progress.length === 0 && (
          <article className="message system">
            <div className="message-avatar">A</div>
            <div className="message-body">
              <div className="message-meta">
                <strong>Arbiter</strong>
                <span>Starting</span>
              </div>
              <pre>Preparing context.</pre>
            </div>
          </article>
        )}
      </section>
      <section className="slack-thread-panel" aria-label="Point thread">
        {selectedFinding ? (
          <PointThread finding={selectedFinding} />
        ) : (
          <div className="thread-empty-state">
            <MessageSquare size={24} />
            <h2>{kind === "code-review" ? "Finding thread" : "Point thread"}</h2>
            <p>No point selected.</p>
          </div>
        )}
      </section>
    </div>
  );
}

function TimelineMessage({ message }: { message: Conversation["messages"][number] }): JSX.Element {
  const author = authorForMessage(message);
  return (
    <article className={`message ${message.role}`}>
      <div className="message-avatar">{avatarForMessage(message, author)}</div>
      <div className="message-body">
        <div className="message-meta">
          <strong>{author}</strong>
          <span>{new Date(message.createdAt).toLocaleString()}</span>
          {message.progressPhase && <span className="phase-badge">{message.progressPhase}</span>}
          {message.status === "error" && <span className="status-error">error</span>}
        </div>
        <pre>{displayMessageContent(message)}</pre>
      </div>
    </article>
  );
}

function PointTimelineMessage(props: { finding: Finding; selected: boolean; onSelect: () => void }): JSX.Element {
  const { finding, selected, onSelect } = props;
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
      <div className="message-avatar">A</div>
      <div className="message-body">
        <div className="message-meta">
          <strong>Arbiter</strong>
          <span>Point extracted</span>
          <PointStatusBadge finding={finding} />
          <span className={`severity ${finding.severity.toLowerCase()}`}>{finding.severity}</span>
        </div>
        <h3>{finding.title}</h3>
        <p>{finding.claim || finding.description}</p>
        <small>{finding.rounds.length} thread {finding.rounds.length === 1 ? "reply" : "replies"}</small>
      </div>
    </article>
  );
}

function PointThread({ finding }: { finding: Finding }): JSX.Element {
  const replies = pointThreadReplies(finding);

  return (
    <div className="point-thread">
      <div className="thread-panel-head">
        <div>
          <span>Thread</span>
          <h2>{finding.title}</h2>
        </div>
        <PointStatusBadge finding={finding} />
      </div>

      <ThreadMessage
        avatar="A"
        author="Arbiter"
        meta="Parent point"
        createdAt={finding.createdAt}
        content={`Searching for consensus on point "${finding.title}".`}
        title={finding.title}
        badges={
          <>
            <PointStatusBadge finding={finding} />
            <span className={`severity ${finding.severity.toLowerCase()}`}>{finding.severity}</span>
          </>
        }
      />

      <div className="thread-replies">
        {replies.map((reply) => (
          <ThreadMessage
            avatar={initials(reply.author)}
            author={reply.author}
            meta={reply.meta}
            createdAt={reply.createdAt}
            content={reply.content}
            key={reply.id}
          />
        ))}
      </div>
    </div>
  );
}

function ThreadMessage(props: {
  avatar: string;
  author: string;
  meta: string;
  createdAt?: string;
  title?: string;
  content: string;
  badges?: React.ReactNode;
}): JSX.Element {
  return (
    <article className="thread-message">
      <div className="thread-avatar">{props.avatar}</div>
      <div className="thread-bubble">
        <div className="message-meta">
          <strong>{props.author}</strong>
          <span>{props.meta}</span>
          {props.createdAt && <span>{new Date(props.createdAt).toLocaleString()}</span>}
          {props.badges}
        </div>
        {props.title && <h3>{props.title}</h3>}
        <pre>{props.content}</pre>
      </div>
    </article>
  );
}

function PointsView({ conversation, kind }: { conversation?: Conversation; kind: ConversationKind }): JSX.Element {
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
              <span className={`severity ${severity.toLowerCase()}`}>{severity}</span>
              {items.length}
            </h3>
            <PointTable findings={items} emptyLabel="No points" />
          </section>
        );
      })}
      <section className="severity-section filtered-section">
        <h3>
          <span className="status-badge filtered-out">Filtered out</span>
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
        <span className={`severity ${finding.severity.toLowerCase()}`}>{finding.severity}</span>
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

function PointStatusBadge({ finding }: { finding: Finding }): JSX.Element {
  const status = pointStatus(finding);
  const Icon = status.kind === "confirmed" ? CheckCircle2 : status.kind === "filtered-out" ? XCircle : HelpCircle;
  return (
    <span className={`status-badge ${status.kind}`}>
      <Icon size={15} />
      {status.label}
    </span>
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

function progressToMessage(progress: ReviewProgress): Conversation["messages"][number] {
  return {
    id: `${progress.runId}:${progress.createdAt}:${progress.phase}:${progress.message}`,
    role: "system",
    participantId: "arbiter",
    participantLabel: "Arbiter",
    content: progress.message,
    createdAt: progress.createdAt,
    status: progress.phase === "error" || progress.phase === "cancelled" ? "error" : "done",
    progressPhase: progress.phase
  };
}

function displayMessageContent(message: Conversation["messages"][number]): string {
  return summarizeRawProviderJson(message.content) ?? message.content;
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

function mergeProgressIntoConversation(conversation: Conversation, progress: ReviewProgress[]): Conversation {
  if (progress.length === 0) {
    return conversation;
  }

  const existing = new Set(conversation.messages.map(messageKey));
  const missing = progress
    .map(progressToMessage)
    .filter((message) => {
      const key = messageKey(message);
      if (existing.has(key)) {
        return false;
      }
      existing.add(key);
      return true;
    });

  if (missing.length === 0) {
    return conversation;
  }

  const [firstMessage, ...rest] = [...conversation.messages, ...missing].sort(
    (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)
  );
  const userMessages = [firstMessage, ...rest].filter((message) => message.role === "user");
  const otherMessages = [firstMessage, ...rest].filter((message) => message.role !== "user");

  return {
    ...conversation,
    messages: [...userMessages, ...otherMessages]
  };
}

function messageKey(message: Conversation["messages"][number]): string {
  return `${message.progressPhase ?? ""}|${message.createdAt}|${message.content}`;
}

function authorForMessage(message: Conversation["messages"][number]): string {
  if (message.role === "user") {
    return "You";
  }
  if (message.role === "system") {
    return "Arbiter";
  }
  if (message.participantLabel?.toLowerCase().includes("(arbiter)")) {
    return "Arbiter";
  }
  return message.participantLabel || labelForRole(message.role);
}

function avatarForMessage(message: Conversation["messages"][number], author: string): string {
  if (message.role === "user") {
    return "You";
  }
  if (message.role === "system") {
    return "A";
  }
  return author
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "M";
}

function stanceLabel(stance: string): string {
  return stance
    .split("-")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function pointThreadReplies(finding: Finding): Array<{ id: string; author: string; meta: string; createdAt?: string; content: string; order: number }> {
  const sourceLabels = finding.sourceParticipantLabels?.length ? finding.sourceParticipantLabels : [finding.sourceParticipantLabel];
  const sourceIds = finding.sourceParticipantIds?.length ? finding.sourceParticipantIds : [finding.sourceParticipantId];
  const sourceReplies = sourceLabels.map((label, index) => ({
    id: `source-${sourceIds[index] ?? label}-${index}`,
    author: label,
    meta: "Initial point",
    createdAt: finding.createdAt,
    content: pointSourceContent(finding),
    order: index
  }));
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

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
