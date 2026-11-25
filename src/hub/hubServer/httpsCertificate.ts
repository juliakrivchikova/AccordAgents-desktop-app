import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** Changes whenever either file does. The whole files: a renewed chain
 *  ends in the same intermediate certificate as the one before. */
export function certStamp(files: { cert: string; key: string }): string {
  try {
    return createHash("sha256").update(readFileSync(files.cert)).update(readFileSync(files.key)).digest("hex");
  } catch {
    return "";
  }
}
