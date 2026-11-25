import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** The phone app's own modules as one text, for checks of what its code says. */
export async function phoneAppSource(repoRoot) {
  const folder = path.join(repoRoot, "src/mobile/app");
  const names = (await readdir(folder, { recursive: true })).filter((name) => name.endsWith(".js")).sort();
  return (await Promise.all(names.map((name) => readFile(path.join(folder, name), "utf8")))).join("\n");
}
