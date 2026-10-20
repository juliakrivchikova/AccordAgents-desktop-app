import { appendFileSync, mkdirSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { hostPlatform, userDataPath } from "../platform";

export class DebugLogService {
  private readonly enabled = process.env.ACCORD_AGENTS_DEBUG_LOGS === "1" || (!hostPlatform().isPackaged() && process.env.ACCORD_AGENTS_DEBUG_LOGS !== "0");
  private readonly logDir = path.join(userDataPath(), "debug-logs");

  async write(event: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.enabled) {
      return;
    }
    try {
      await mkdir(this.logDir, { recursive: true });
      const [file, line] = this.entry(event, payload);
      await appendFile(file, line, "utf8");
    } catch {
      // Debug logging must never affect the consensus run.
    }
  }

  /** Written before returning, for the moments the process may end right
   *  after (a quit, a restart for an update): a line still queued when the
   *  app exits is lost. */
  writeNow(event: string, payload: Record<string, unknown>): void {
    if (!this.enabled) {
      return;
    }
    try {
      mkdirSync(this.logDir, { recursive: true });
      const [file, line] = this.entry(event, payload);
      appendFileSync(file, line, "utf8");
    } catch {
      // Debug logging must never affect the consensus run.
    }
  }

  private entry(event: string, payload: Record<string, unknown>): [string, string] {
    const now = new Date();
    return [
      path.join(this.logDir, `${now.toISOString().slice(0, 10)}.jsonl`),
      `${JSON.stringify({ event, timestamp: now.toISOString(), ...payload })}\n`
    ];
  }
}
