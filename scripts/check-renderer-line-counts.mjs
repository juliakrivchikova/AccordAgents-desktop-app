import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const rendererRoot = path.join(repoRoot, "src", "renderer");
const maxLines = 400;
const extensions = new Set([".ts", ".tsx"]);
const ignoredSegments = new Set(["assets"]);

function collectFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredSegments.has(entry.name)) {
        collectFiles(fullPath, files);
      }
      continue;
    }
    if (entry.isFile() && extensions.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function lineCount(contents) {
  if (!contents) {
    return 0;
  }
  const newlines = contents.match(/\n/g)?.length ?? 0;
  return newlines + (contents.endsWith("\n") ? 0 : 1);
}

const oversized = collectFiles(rendererRoot)
  .map((file) => ({
    file,
    lines: lineCount(fs.readFileSync(file, "utf8"))
  }))
  .filter((entry) => entry.lines > maxLines)
  .sort((left, right) => right.lines - left.lines || left.file.localeCompare(right.file));

if (oversized.length > 0) {
  console.error(`Renderer files must stay at or below ${maxLines} lines:`);
  for (const entry of oversized) {
    console.error(`  ${entry.lines.toString().padStart(4)} ${path.relative(repoRoot, entry.file)}`);
  }
  process.exit(1);
}

console.log(`Renderer line-count guardrail passed (${maxLines} lines max).`);
