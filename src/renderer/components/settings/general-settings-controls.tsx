// The number and context controls of Settings → General, each with its own
// Save (moved out of general-settings-section.tsx to keep it readable).
import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";

import type {
  ChatPromptContextMode,
  ChatPromptContextScopeSettings,
  ChatPromptContextSettings
} from "../../../shared/types";
import {
  CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_MAX,
  CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_MIN,
  CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_MAX,
  CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_MIN
} from "../../../shared/chatParticipantRequests";
import {
  CHAT_AUTO_WATCH_WAKE_LIMIT_MAX,
  CHAT_AUTO_WATCH_WAKE_LIMIT_MIN
} from "../../../shared/chatAutoWatch";
import { CLI_AGENT_RUN_TIMEOUT_MAX_MS, CLI_AGENT_RUN_TIMEOUT_MIN_MS, cliAgentRunTimeoutHours } from "../../../shared/cliAgentRunSettings";
import {
  CHAT_PROMPT_CONTEXT_LIMIT_MAX,
  normalizeChatPromptContextSettings
} from "../../../shared/chatPromptContext";

export const PARTICIPANT_REQUEST_DEPTH_HELP = "Limits transitive member-to-member request nesting, not repeated rounds by the same requester.";
export const PARTICIPANT_REQUEST_PROMPT_MAX_HELP = "Maximum characters accepted for each member request prompt. Longer prompts are rejected, not truncated.";
export const AUTO_WATCH_WAKE_LIMIT_HELP = "Pauses auto-watch after this many automatic watcher runs happen without a user message.";

export function CliAgentRunTimeoutControl(props: {
  timeoutMs: number;
  onChange: (timeoutMs: number) => Promise<void>;
}): JSX.Element {
  const currentHours = cliAgentRunTimeoutHours(props.timeoutMs);
  const [hours, setHours] = useState(String(currentHours));
  const minHours = CLI_AGENT_RUN_TIMEOUT_MIN_MS / (60 * 60_000);
  const maxHours = CLI_AGENT_RUN_TIMEOUT_MAX_MS / (60 * 60_000);
  const trimmed = hours.trim();
  const parsed = Number(trimmed);
  const validation = trimmed === ""
    ? undefined
    : !Number.isFinite(parsed) || !Number.isInteger(parsed)
      ? "Use a whole number of hours."
      : parsed < minHours || parsed > maxHours
        ? `Use ${minHours} to ${maxHours} hours.`
        : undefined;
  const timeoutMs = parsed * 60 * 60_000;
  const canSave = trimmed !== "" && !validation && timeoutMs !== props.timeoutMs;

  useEffect(() => {
    setHours(String(currentHours));
  }, [currentHours]);

  return (
    <div className="gen-row-control">
      <div className="gen-timeout">
        <div className="gen-timeout-field">
          <input
            className="gen-timeout-input"
            inputMode="numeric"
            value={hours}
            aria-label="Run timeout in hours"
            onChange={(event) => setHours(event.target.value)}
          />
          <span className="gen-timeout-unit">Hours</span>
        </div>
        <button
          type="button"
          className={`gen-timeout-save ${canSave ? "is-dirty" : ""}`}
          disabled={!canSave}
          onClick={() => void props.onChange(timeoutMs)}
        >
          Save
        </button>
      </div>
      {validation && <div className="gen-timeout-error">{validation}</div>}
    </div>
  );
}

export function PromptContextControl(props: {
  settings: ChatPromptContextSettings;
  onChange: (settings: ChatPromptContextSettings) => Promise<void>;
}): JSX.Element {
  const [threadMode, setThreadMode] = useState<ChatPromptContextMode>(props.settings.thread.mode);
  const [threadLimit, setThreadLimit] = useState(String(props.settings.thread.limit ?? 0));
  const [timelineMode, setTimelineMode] = useState<ChatPromptContextMode>(props.settings.timeline.mode);
  const [timelineLimit, setTimelineLimit] = useState(String(props.settings.timeline.limit ?? 3));

  useEffect(() => {
    setThreadMode(props.settings.thread.mode);
    setThreadLimit(String(props.settings.thread.limit ?? 0));
    setTimelineMode(props.settings.timeline.mode);
    setTimelineLimit(String(props.settings.timeline.limit ?? 3));
  }, [props.settings]);

  const threadValidation = promptContextLimitValidation(threadMode, threadLimit);
  const timelineValidation = promptContextLimitValidation(timelineMode, timelineLimit);
  const draft = normalizeChatPromptContextSettings({
    thread: promptContextScopeDraft(threadMode, threadLimit),
    timeline: promptContextScopeDraft(timelineMode, timelineLimit)
  });
  const canSave = !threadValidation && !timelineValidation && JSON.stringify(draft) !== JSON.stringify(props.settings);

  return (
    <div className="gen-row-control prompt-context-control">
      <PromptContextScopeControl
        label="Thread"
        mode={threadMode}
        limit={threadLimit}
        validation={threadValidation}
        onModeChange={setThreadMode}
        onLimitChange={setThreadLimit}
      />
      <PromptContextScopeControl
        label="Timeline"
        mode={timelineMode}
        limit={timelineLimit}
        validation={timelineValidation}
        onModeChange={setTimelineMode}
        onLimitChange={setTimelineLimit}
      />
      <button
        type="button"
        className={`gen-timeout-save ${canSave ? "is-dirty" : ""}`}
        disabled={!canSave}
        onClick={() => void props.onChange(draft)}
      >
        Save
      </button>
    </div>
  );
}

function PromptContextScopeControl(props: {
  label: string;
  mode: ChatPromptContextMode;
  limit: string;
  validation?: string;
  onModeChange: (mode: ChatPromptContextMode) => void;
  onLimitChange: (limit: string) => void;
}): JSX.Element {
  const latest = props.mode === "latest_unseen";
  return (
    <div className="gen-timeout prompt-context-scope">
      <label className="prompt-context-select-wrap">
        <span className="sr-only">{props.label} prompt context mode</span>
        <select
          className="prompt-context-select"
          value={props.mode}
          onChange={(event) => props.onModeChange(event.target.value as ChatPromptContextMode)}
          aria-label={`${props.label} prompt context mode`}
        >
          <option value="off">{props.label}: Off</option>
          <option value="all_unseen">{props.label}: All unseen</option>
          <option value="latest_unseen">{props.label}: Latest unseen</option>
        </select>
        <ChevronDown aria-hidden="true" size={14} />
      </label>
      <div className="gen-timeout-field">
        <input
          className="gen-timeout-input"
          inputMode="numeric"
          value={latest ? props.limit : "0"}
          disabled={!latest}
          aria-label={`${props.label} prompt context limit`}
          onChange={(event) => props.onLimitChange(event.target.value)}
        />
        <span className="gen-timeout-unit">Msgs</span>
      </div>
      {props.validation && <div className="gen-timeout-error">{props.validation}</div>}
    </div>
  );
}

function promptContextScopeDraft(mode: ChatPromptContextMode, limit: string): ChatPromptContextScopeSettings {
  if (mode === "off") {
    return { mode: "off" };
  }
  if (mode === "all_unseen") {
    return { mode: "all_unseen" };
  }
  return { mode: "latest_unseen", limit: Number(limit.trim()) };
}

function promptContextLimitValidation(mode: ChatPromptContextMode, limit: string): string | undefined {
  if (mode !== "latest_unseen") {
    return undefined;
  }
  const trimmed = limit.trim();
  const parsed = Number(trimmed);
  if (trimmed === "" || !Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return "Use a whole number.";
  }
  if (parsed < 0 || parsed > CHAT_PROMPT_CONTEXT_LIMIT_MAX) {
    return `Use 0 to ${CHAT_PROMPT_CONTEXT_LIMIT_MAX} messages.`;
  }
  return undefined;
}

export function ParticipantRequestDepthControl(props: {
  maxDepth: number;
  onChange: (maxDepth: number) => Promise<void>;
}): JSX.Element {
  const [depth, setDepth] = useState(String(props.maxDepth));
  const trimmed = depth.trim();
  const parsed = Number(trimmed);
  const validation = trimmed === ""
    ? undefined
    : !Number.isFinite(parsed) || !Number.isInteger(parsed)
      ? "Use a whole number."
      : parsed < CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_MIN || parsed > CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_MAX
        ? `Use ${CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_MIN} to ${CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_MAX} levels.`
        : undefined;
  const canSave = trimmed !== "" && !validation && parsed !== props.maxDepth;

  useEffect(() => {
    setDepth(String(props.maxDepth));
  }, [props.maxDepth]);

  return (
    <div className="gen-row-control">
      <div className="gen-timeout">
        <div className="gen-timeout-field">
          <input
            className="gen-timeout-input"
            inputMode="numeric"
            value={depth}
            aria-label="Member request max depth"
            title={PARTICIPANT_REQUEST_DEPTH_HELP}
            onChange={(event) => setDepth(event.target.value)}
          />
          <span className="gen-timeout-unit">Levels</span>
        </div>
        <button
          type="button"
          className={`gen-timeout-save ${canSave ? "is-dirty" : ""}`}
          disabled={!canSave}
          onClick={() => void props.onChange(parsed)}
        >
          Save
        </button>
      </div>
      {validation && <div className="gen-timeout-error">{validation}</div>}
    </div>
  );
}

export function AutoWatchWakeLimitControl(props: {
  limit: number;
  onChange: (limit: number) => Promise<void>;
}): JSX.Element {
  const [limit, setLimit] = useState(String(props.limit));
  const trimmed = limit.trim();
  const parsed = Number(trimmed);
  const validation = trimmed === ""
    ? undefined
    : !Number.isFinite(parsed) || !Number.isInteger(parsed)
      ? "Use a whole number."
      : parsed < CHAT_AUTO_WATCH_WAKE_LIMIT_MIN || parsed > CHAT_AUTO_WATCH_WAKE_LIMIT_MAX
        ? `Use ${CHAT_AUTO_WATCH_WAKE_LIMIT_MIN} to ${CHAT_AUTO_WATCH_WAKE_LIMIT_MAX} runs.`
        : undefined;
  const canSave = trimmed !== "" && !validation && parsed !== props.limit;

  useEffect(() => {
    setLimit(String(props.limit));
  }, [props.limit]);

  return (
    <div className="gen-row-control">
      <div className="gen-timeout">
        <div className="gen-timeout-field">
          <input
            className="gen-timeout-input"
            inputMode="numeric"
            value={limit}
            aria-label="Auto-watch run limit"
            title={AUTO_WATCH_WAKE_LIMIT_HELP}
            onChange={(event) => setLimit(event.target.value)}
          />
          <span className="gen-timeout-unit">Runs</span>
        </div>
        <button
          type="button"
          className={`gen-timeout-save ${canSave ? "is-dirty" : ""}`}
          disabled={!canSave}
          onClick={() => void props.onChange(parsed)}
        >
          Save
        </button>
      </div>
      {validation && <div className="gen-timeout-error">{validation}</div>}
    </div>
  );
}

export function ParticipantRequestPromptMaxControl(props: {
  maxChars: number;
  onChange: (maxChars: number) => Promise<void>;
}): JSX.Element {
  const [maxChars, setMaxChars] = useState(String(props.maxChars));
  const trimmed = maxChars.trim();
  const parsed = Number(trimmed);
  const validation = trimmed === ""
    ? undefined
    : !Number.isFinite(parsed) || !Number.isInteger(parsed)
      ? "Use a whole number."
      : parsed < CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_MIN || parsed > CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_MAX
        ? `Use ${CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_MIN.toLocaleString()} to ${CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_MAX.toLocaleString()} characters.`
        : undefined;
  const canSave = trimmed !== "" && !validation && parsed !== props.maxChars;

  useEffect(() => {
    setMaxChars(String(props.maxChars));
  }, [props.maxChars]);

  return (
    <div className="gen-row-control">
      <div className="gen-timeout">
        <div className="gen-timeout-field">
          <input
            className="gen-timeout-input"
            inputMode="numeric"
            value={maxChars}
            aria-label="Member request prompt max characters"
            title={PARTICIPANT_REQUEST_PROMPT_MAX_HELP}
            onChange={(event) => setMaxChars(event.target.value)}
          />
          <span className="gen-timeout-unit">Chars</span>
        </div>
        <button
          type="button"
          className={`gen-timeout-save ${canSave ? "is-dirty" : ""}`}
          disabled={!canSave}
          onClick={() => void props.onChange(parsed)}
        >
          Save
        </button>
      </div>
      {validation && <div className="gen-timeout-error">{validation}</div>}
    </div>
  );
}
