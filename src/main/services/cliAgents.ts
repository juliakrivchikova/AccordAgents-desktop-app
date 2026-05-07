import type { AgentHealth, GitDiffMode, ParticipantConfig } from "../../shared/types";
import { CommandError, commandExists, runCommand } from "./command";
import type { ParticipantRunResult } from "./providers";

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
    signal?: AbortSignal
  ): Promise<ParticipantRunResult> {
    if (participant.kind === "codex-cli") {
      return this.runCodex(participant, prompt, repoPath, diffMode, signal);
    }
    if (participant.kind === "claude-code") {
      return this.runClaude(participant, prompt, repoPath, signal);
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
    signal?: AbortSignal
  ): Promise<ParticipantRunResult> {
    const startedAt = Date.now();
    try {
      const args = [
        "exec",
        "--sandbox",
        "read-only",
        "--json",
        "-"
      ];
      if (repoPath) {
        args.splice(1, 0, "--cd", repoPath);
      } else {
        args.splice(1, 0, "--skip-git-repo-check", "--ephemeral", "--ignore-rules");
      }
      const result = await runCommand("codex", args, {
        cwd: repoPath,
        input: this.codexPrompt(prompt, diffMode),
        timeoutMs: 4 * 60_000,
        signal
      });
      return { participant, ok: true, content: this.extractCodexText(result.stdout), durationMs: Date.now() - startedAt };
    } catch (error) {
      return this.failed(participant, error, Date.now() - startedAt);
    }
  }

  private async runClaude(participant: ParticipantConfig, prompt: string, repoPath: string | undefined, signal?: AbortSignal): Promise<ParticipantRunResult> {
    const startedAt = Date.now();
    try {
      const args = [
        "-p",
        "--output-format",
        "json",
        "--no-session-persistence",
        "--permission-mode",
        "plan",
        "--disallowedTools",
        "Edit,Write,MultiEdit,NotebookEdit,Bash"
      ];
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
      return { participant, ok: true, content: this.extractClaudeText(result.stdout), durationMs: Date.now() - startedAt };
    } catch (error) {
      return this.failed(participant, error, Date.now() - startedAt);
    }
  }

  private codexPrompt(prompt: string, diffMode: GitDiffMode | undefined): string {
    return [
      diffMode
        ? "You are running inside the selected repository in read-only mode. Inspect files and git state as needed. Do not edit files."
        : "Answer the user's question directly. Do not inspect local files unless context is explicitly provided.",
      diffMode ? `The user selected diff mode: ${diffMode}.` : "",
      prompt
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private extractCodexText(stdout: string): string {
    const texts: string[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const event = JSON.parse(line) as unknown;
        const extracted = this.collectStrings(event);
        texts.push(...extracted);
      } catch {
        texts.push(line);
      }
    }
    return this.bestText(texts) || stdout.trim();
  }

  private extractClaudeText(stdout: string): string {
    try {
      const parsed = JSON.parse(stdout) as { result?: string; content?: string; message?: string };
      return parsed.result ?? parsed.content ?? parsed.message ?? stdout.trim();
    } catch {
      return stdout.trim();
    }
  }

  private collectStrings(value: unknown): string[] {
    if (!value || typeof value !== "object") {
      return [];
    }
    const strings: string[] = [];
    const stack: unknown[] = [value];
    const keys = new Set(["text", "content", "message", "output_text", "result"]);

    while (stack.length) {
      const current = stack.pop();
      if (Array.isArray(current)) {
        stack.push(...current);
      } else if (current && typeof current === "object") {
        for (const [key, nested] of Object.entries(current)) {
          if (typeof nested === "string" && keys.has(key) && nested.trim().length > 20) {
            strings.push(nested.trim());
          } else if (nested && typeof nested === "object") {
            stack.push(nested);
          }
        }
      }
    }
    return strings;
  }

  private bestText(texts: string[]): string {
    const unique = Array.from(new Set(texts.map((text) => text.trim()).filter(Boolean)));
    unique.sort((a, b) => b.length - a.length);
    return unique[0] ?? "";
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
      return (error.result.stderr || error.result.stdout || error.message).trim();
    }
    return error instanceof Error ? error.message : String(error);
  }
}
