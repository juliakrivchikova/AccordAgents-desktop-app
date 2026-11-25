#!/usr/bin/env node
// No source file is longer than 1000 lines: a file that grows past it is split
// by subject (docs/code-structure.md), never by line count alone.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_LINES = 1000;
const ROOTS = ["src", "scripts"];
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".css"]);

function collect(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(full, files);
    // What a script generates is not read or edited by hand.
    else if (EXTENSIONS.has(path.extname(entry.name)) && !/\.generated\.[a-z]+$/.test(entry.name)) files.push(full);
  }
  return files;
}

/** Every source file over the limit, longest first. */
export function longFiles(repoRoot) {
  return ROOTS.flatMap((root) => collect(path.join(repoRoot, root)))
    .map((file) => ({ file: path.relative(repoRoot, file), lines: fs.readFileSync(file, "utf8").replace(/\n$/, "").split("\n").length }))
    .filter(({ lines }) => lines > MAX_LINES)
    .sort((left, right) => right.lines - left.lines);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const long = longFiles(process.cwd());
  if (long.length > 0) {
    console.error(`Source files must stay at or below ${MAX_LINES} lines:`);
    for (const { file, lines } of long) console.error(`  ${String(lines).padStart(5)} ${file}`);
    process.exit(1);
  }
  console.log(`File lengths passed (${MAX_LINES} lines max).`);
}
