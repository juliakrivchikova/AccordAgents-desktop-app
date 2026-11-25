import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * A subject's source files: the file itself and the parts in the folder of the
 * same name (src/main/services/chat.ts and src/main/services/chat/**), without
 * their tests. Guards read a subject through this, so a part added later is
 * guarded too.
 */
export function sourceParts(repoRoot, relative) {
  const extension = path.extname(relative);
  const folder = relative.slice(0, -extension.length);
  const files = existsSync(path.join(repoRoot, relative)) ? [relative] : [];
  if (existsSync(path.join(repoRoot, folder))) {
    const names = readdirSync(path.join(repoRoot, folder), { recursive: true }).map(String).sort();
    for (const name of names) {
      if (name.endsWith(extension) && !/\.test\.[a-z]+$/.test(name) && !name.split(path.sep).includes("test")) {
        files.push(path.join(folder, name));
      }
    }
  }
  if (!files.length) throw new Error(`${relative} has no source files.`);
  return files;
}

/** The same files as one text. */
export function sourceText(repoRoot, relative) {
  return sourceParts(repoRoot, relative).map((file) => readFileSync(path.join(repoRoot, file), "utf8")).join("\n");
}
