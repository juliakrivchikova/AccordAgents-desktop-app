import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";

export class DebugLogService {
  private readonly enabled = process.env.AI_CONSENSUS_DEBUG_LOGS === "1" || (!app.isPackaged && process.env.AI_CONSENSUS_DEBUG_LOGS !== "0");
  private readonly logDir = path.join(app.getPath("userData"), "debug-logs");

  async write(event: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.enabled) {
      return;
    }
    try {
      await mkdir(this.logDir, { recursive: true });
      const now = new Date();
      const file = path.join(this.logDir, `${now.toISOString().slice(0, 10)}.jsonl`);
      await appendFile(file, `${JSON.stringify({ event, timestamp: now.toISOString(), ...payload })}\n`, "utf8");
    } catch {
      // Debug logging must never affect the consensus run.
    }
  }
}
