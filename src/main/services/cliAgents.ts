import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentHealth, ConversationKind, GitDiffMode, ParticipantConfig } from "../../shared/types";
import { CommandError, commandExists, runCommand } from "./command";
import type { ParticipantRunResult } from "./providers";

const MAX_CLI_ERROR_CHARS = 500;
const MAX_CLI_ERROR_LINES = 8;
const MAX_CLI_EVENT_SUMMARIES = 2;

export interface CliAgentRunOptions {
  persistSession?: boolean;
  sessionId?: string;
}

export class CliAgentRunner {
  async detectAgents(): Promise<AgentHealth[]> {
    const [codex, claude] = await Promise.all([this.detectCodex(), this.detectClaude()]);
    return [codex, claude];
  }

  async run(
    participant: ParticipantConfig,
    prompt: string,
    repoPath: string | undefined,
    diffMode: GitDiffMode | undefined,
    kind: ConversationKind,
    signal?: AbortSignal,
    options: CliAgentRunOptions = {}
  ): Promise<ParticipantRunResult> {
    const effectiveRepoPath = this.repoPathForRun(repoPath, diffMode, kind);
    if (participant.kind === "codex-cli") {
      return this.runCodex(participant, prompt, effectiveRepoPath, diffMode, kind, signal, options);
    }
    if (participant.kind === "claude-code") {
      return this.runClaude(participant, prompt, effectiveRepoPath, signal, options);
    }
    return { participant, ok: false, content: "", error: `${participant.label} is not a CLI agent.` };
  }

  private async detectCodex(): Promise<AgentHealth> {
    const command = await commandExists("codex");
    if (!command.path) {
      return { kind: "codex-cli", label: "Codex CLI", installed: false, error: command.error };
    }
    try {
      const version = await runCommand("codex", ["--version"], { timeoutMs: 10_000 });
      return { kind: "codex-cli", label: "Codex CLI", installed: true, path: command.path, version: version.stdout.trim() };
    } catch (error) {
      return { kind: "codex-cli", label: "Codex CLI", installed: true, path: command.path, error: this.errorText(error) };
    }
  }

  private async detectClaude(): Promise<AgentHealth> {
    const command = await commandExists("claude");
    if (!command.path) {
      return { kind: "claude-code", label: "Claude Code", installed: false, error: command.error };
    }
    try {
      const version = await runCommand("claude", ["--version"], { timeoutMs: 10_000 });
      return { kind: "claude-code", label: "Claude Code", installed: true, path: command.path, version: version.stdout.trim() };
    } catch (error) {
      return { kind: "claude-code", label: "Claude Code", installed: true, path: command.path, error: this.errorText(error) };
    }
  }

  private async runCodex(
    participant: ParticipantConfig,
    prompt: string,
    repoPath: string | undefined,
    diffMode: GitDiffMode | undefined,
    kind: ConversationKind,
    signal?: AbortSignal,
    options: CliAgentRunOptions = {}
  ): Promise<ParticipantRunResult> {
    const startedAt = Date.now();
    let outputDir: string | undefined;
    try {
      outputDir = await mkdtemp(path.join(tmpdir(), "ai-consensus-codex-"));
      const outputPath = path.join(outputDir, "last-message.txt");
      const resuming = Boolean(options.sessionId);
      const args = resuming
        ? [
            "exec",
            "resume",
            "--json",
            "--output-last-message",
            outputPath,
            options.sessionId as string,
            "-"
          ]
        : [
            "exec",
            "--sandbox",
            "read-only",
            "--json",
            "--output-last-message",
            outputPath,
            "-"
          ];
      if (repoPath && !resuming) {
        args.splice(1, 0, "--cd", repoPath);
      } else if (!repoPath && !resuming) {
        // Session persistence is only useful when a repository is selected. For free-form runs,
        // keep Codex ephemeral so unrelated conversations do not bleed together.
        args.splice(1, 0, "--skip-git-repo-check", "--ephemeral", "--ignore-rules");
      } else if (!repoPath && resuming) {
        args.splice(2, 0, "--skip-git-repo-check");
      }
      const result = await runCommand("codex", args, {
        cwd: repoPath,
        input: this.codexPrompt(prompt, repoPath, diffMode, kind),
        timeoutMs: 4 * 60_000,
        signal
      });
      const lastMessage = await this.readOptionalFile(outputPath);
      return {
        participant,
        ok: true,
        content: lastMessage.trim() || this.extractCodexText(result.stdout),
        durationMs: Date.now() - startedAt,
        sessionId: this.extractCodexSessionId(result.stdout) ?? options.sessionId
      };
    } catch (error) {
      if (options.sessionId && this.isResumeMiss(error)) {
        const restarted = await this.runCodex(participant, prompt, repoPath, diffMode, kind, signal, { persistSession: options.persistSession });
        return { ...restarted, sessionRestarted: true };
      }
      return this.failed(participant, error, Date.now() - startedAt);
    } finally {
      if (outputDir) {
        await rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private async runClaude(
    participant: ParticipantConfig,
    prompt: string,
    repoPath: string | undefined,
    signal?: AbortSignal,
    options: CliAgentRunOptions = {}
  ): Promise<ParticipantRunResult> {
    const startedAt = Date.now();
    const newSessionId = options.persistSession && !options.sessionId ? randomUUID() : undefined;
    try {
      const args = [
        "-p",
        "--output-format",
        "json",
        "--permission-mode",
        "plan",
        "--disallowedTools",
        "Edit,Write,MultiEdit,NotebookEdit,Bash"
      ];
      if (options.sessionId) {
        args.push("--resume", options.sessionId);
      } else if (newSessionId) {
        args.push("--session-id", newSessionId);
      }
      if (repoPath) {
        args.push("--tools", "Read,Grep,Glob,LS");
      } else {
        args.push("--tools", "");
      }

      const result = await runCommand(
        "claude",
        args,
        {
          cwd: repoPath,
          input: prompt,
          timeoutMs: 4 * 60_000,
          signal
        }
      );
      return {
        participant,
        ok: true,
        content: this.extractClaudeText(result.stdout),
        durationMs: Date.now() - startedAt,
        sessionId: this.extractClaudeSessionId(result.stdout) ?? newSessionId ?? options.sessionId
      };
    } catch (error) {
      if (options.sessionId && this.isResumeMiss(error)) {
        const restarted = await this.runClaude(participant, prompt, repoPath, signal, { persistSession: options.persistSession });
        return { ...restarted, sessionRestarted: true };
      }
      return this.failed(participant, error, Date.now() - startedAt);
    }
  }

  private codexPrompt(
    prompt: string,
    repoPath: string | undefined,
    diffMode: GitDiffMode | undefined,
    kind: ConversationKind
  ): string {
    if (kind === "implementation-plan") {
      return [
        "You are running inside the selected repository in plan mode and read-only sandbox mode.",
        "Inspect files and git state as needed. Do not edit files, run mutating commands, install dependencies, or wait for terminal confirmation.",
        "If a blocking product or technical decision is needed, report it in the requested output format instead of asking interactively.",
        prompt
      ].join("\n\n");
    }

    const hasRepoContext = Boolean(repoPath) && (kind === "code-review" || Boolean(diffMode));

    return [
      hasRepoContext
        ? "You are running inside the selected repository in read-only mode. Inspect files and git state as needed. Do not edit files."
        : diffMode
          ? "Use the provided diff context. Do not inspect local files unless repository context is explicitly provided."
          : "Answer the user's question directly. Do not inspect local files unless context is explicitly provided.",
      diffMode ? `The user selected diff mode: ${diffMode}.` : "",
      prompt
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private repoPathForRun(repoPath: string | undefined, diffMode: GitDiffMode | undefined, kind: ConversationKind): string | undefined {
    if (!repoPath) {
      return undefined;
    }
    return kind === "code-review" || kind === "implementation-plan" || Boolean(diffMode) ? repoPath : undefined;
  }

  private extractCodexText(stdout: string): string {
    const messages: string[] = [];
    const deltas: string[] = [];
    const plainLines: string[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const event = JSON.parse(line) as unknown;
        const message = this.extractCodexAssistantMessage(event);
        if (message) {
          messages.push(message);
        }
        const delta = this.extractCodexAssistantDelta(event);
        if (delta) {
          deltas.push(delta);
        }
      } catch {
        plainLines.push(line.trim());
      }
    }
    return messages.at(-1) ?? (deltas.join("").trim() || plainLines.join("\n").trim() || stdout.trim());
  }

  private extractClaudeText(stdout: string): string {
    try {
      const parsed = JSON.parse(stdout) as { result?: string; content?: string; message?: string };
      return parsed.result ?? parsed.content ?? parsed.message ?? stdout.trim();
    } catch {
      return stdout.trim();
    }
  }

  private extractClaudeSessionId(stdout: string): string | undefined {
    try {
      const parsed = JSON.parse(stdout) as { session_id?: string; sessionId?: string };
      return this.uuidText(parsed.session_id) ?? this.uuidText(parsed.sessionId);
    } catch {
      return undefined;
    }
  }

  private extractCodexSessionId(stdout: string): string | undefined {
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const event = JSON.parse(line) as unknown;
        const sessionId = this.findSessionId(event);
        if (sessionId) {
          return sessionId;
        }
      } catch {
        // Ignore non-JSON status lines from the CLI.
      }
    }
    return undefined;
  }

  private async readOptionalFile(filePath: string): Promise<string> {
    try {
      return await readFile(filePath, "utf8");
    } catch {
      return "";
    }
  }

  private extractCodexAssistantMessage(event: unknown): string | undefined {
    const record = this.asRecord(event);
    if (!record) {
      return undefined;
    }

    const type = this.stringField(record, "type");
    if (type === "agent_message") {
      return this.stringField(record, "message")?.trim();
    }

    const item = this.asRecord(record.item);
    if (item) {
      return this.textFromAssistantMessageItem(item);
    }

    return this.textFromAssistantMessageItem(record);
  }

  private extractCodexAssistantDelta(event: unknown): string | undefined {
    const record = this.asRecord(event);
    if (!record) {
      return undefined;
    }
    const type = this.stringField(record, "type") ?? "";
    if (!type.includes("output_text") && type !== "agent_message_delta") {
      return undefined;
    }
    return this.stringField(record, "delta") ?? this.stringField(record, "text") ?? this.stringField(record, "message");
  }

  private textFromAssistantMessageItem(item: Record<string, unknown>): string | undefined {
    const itemType = this.stringField(item, "type");
    const role = this.stringField(item, "role");
    if (itemType !== "message" && itemType !== "assistant_message" && role !== "assistant") {
      return undefined;
    }
    if (role && role !== "assistant") {
      return undefined;
    }

    const directText = this.stringField(item, "message") ?? this.stringField(item, "text") ?? this.stringField(item, "output_text");
    if (directText?.trim()) {
      return directText.trim();
    }

    const content = item.content;
    if (typeof content === "string") {
      return content.trim() || undefined;
    }
    if (!Array.isArray(content)) {
      return undefined;
    }

    const texts = content
      .map((block) => {
        if (typeof block === "string") {
          return block;
        }
        const blockRecord = this.asRecord(block);
        if (!blockRecord) {
          return "";
        }
        return this.stringField(blockRecord, "text") ?? this.stringField(blockRecord, "output_text") ?? "";
      })
      .filter((text) => text.trim());

    return texts.length ? texts.join("\n").trim() : undefined;
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  }

  private stringField(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];
    return typeof value === "string" ? value : undefined;
  }

  private findSessionId(value: unknown): string | undefined {
    const stack: unknown[] = [value];
    const preferredKeys = new Set(["session_id", "sessionId", "conversation_id", "conversationId", "thread_id", "threadId", "id"]);
    while (stack.length) {
      const current = stack.pop();
      if (Array.isArray(current)) {
        stack.push(...current);
        continue;
      }
      const record = this.asRecord(current);
      if (!record) {
        continue;
      }
      for (const key of preferredKeys) {
        const sessionId = this.uuidText(record[key]);
        if (sessionId) {
          return sessionId;
        }
      }
      const type = this.stringField(record, "type") ?? "";
      if (type.toLowerCase().includes("session")) {
        const sessionId = Object.values(record).map((nested) => this.uuidText(nested)).find(Boolean);
        if (sessionId) {
          return sessionId;
        }
      }
      stack.push(...Object.values(record).filter((nested) => nested && typeof nested === "object"));
    }
    return undefined;
  }

  private uuidText(value: unknown): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }
    const match = value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
    return match?.[0];
  }

  private isResumeMiss(error: unknown): boolean {
    const message = this.errorText(error).toLowerCase();
    return /resume|session|conversation|thread/.test(message) && /not found|missing|unknown|cannot|can't|no .*session|no .*found|does not exist/.test(message);
  }

  private failed(participant: ParticipantConfig, error: unknown, durationMs?: number): ParticipantRunResult {
    const message = this.errorText(error);
    return {
      participant,
      ok: false,
      content: `${participant.label} failed: ${message}`,
      error: message,
      durationMs
    };
  }

  private errorText(error: unknown): string {
    if (error instanceof CommandError) {
      return this.commandErrorText(error);
    }
    return this.truncateText(error instanceof Error ? error.message : String(error), MAX_CLI_ERROR_CHARS);
  }

  private commandErrorText(error: CommandError): string {
    const base = error.message.trim();
    const stderr = this.cleanCommandOutput(error.result.stderr);
    if (stderr) {
      return this.truncateText(`${base}: ${stderr}`, MAX_CLI_ERROR_CHARS);
    }

    const structuredSummary = this.summarizeStructuredOutput(error.result.stdout);
    if (structuredSummary) {
      return this.truncateText(`${base}. ${structuredSummary}`, MAX_CLI_ERROR_CHARS);
    }

    const stdout = this.cleanCommandOutput(error.result.stdout);
    if (stdout) {
      return this.truncateText(`${base}. Output: ${stdout}`, MAX_CLI_ERROR_CHARS);
    }

    return base;
  }

  private summarizeStructuredOutput(stdout: string): string | undefined {
    const summaries: string[] = [];
    let sawStructuredOutput = false;

    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) {
        continue;
      }
      try {
        const summary = this.summarizeStructuredEvent(JSON.parse(trimmed));
        sawStructuredOutput = true;
        if (summary) {
          summaries.push(summary);
          if (summaries.length > MAX_CLI_EVENT_SUMMARIES) {
            summaries.shift();
          }
        }
      } catch {
        // Non-JSON stdout is handled by cleanCommandOutput.
      }
    }

    if (summaries.length > 0) {
      return `No stderr was reported; CLI stdout contained structured events only. Last events: ${summaries.join(" | ")}.`;
    }
    if (sawStructuredOutput) {
      return "No stderr was reported. CLI stdout only contained structured events.";
    }
    return undefined;
  }

  private summarizeStructuredEvent(event: unknown): string | undefined {
    const record = this.asRecord(event);
    if (!record) {
      return undefined;
    }

    const type = this.stringField(record, "type") ?? "event";
    const message = this.stringField(record, "message") ?? this.stringField(record, "error");
    if (message) {
      return `${type}: ${this.truncateText(message, 90)}`;
    }

    const item = this.asRecord(record.item);
    if (item) {
      const itemType = this.stringField(item, "type") ?? "item";
      const status = this.stringField(item, "status");
      const command = this.stringField(item, "command");
      const exitCode = typeof item.exit_code === "number" ? ` exit ${item.exit_code}` : "";
      const statusText = status ? ` ${status}` : "";
      if (command) {
        return `${type}/${itemType}${statusText}${exitCode}: ${this.truncateText(command, 90)}`;
      }
      return `${type}/${itemType}${statusText}${exitCode}`;
    }

    const threadId = this.stringField(record, "thread_id");
    if (threadId) {
      return `${type}: ${threadId}`;
    }
    return type;
  }

  private cleanCommandOutput(output: string): string {
    const lines = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      return "";
    }
    const selected = lines.slice(0, MAX_CLI_ERROR_LINES);
    if (lines.length > selected.length) {
      selected.push(`[${lines.length - selected.length} more output lines omitted]`);
    }
    return selected.join("\n");
  }

  private truncateText(text: string, maxChars: number): string {
    const trimmed = text.trim();
    if (trimmed.length <= maxChars) {
      return trimmed;
    }
    return `${trimmed.slice(0, maxChars).trimEnd()}... [truncated ${trimmed.length - maxChars} chars]`;
  }
}
