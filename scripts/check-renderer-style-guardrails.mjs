import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const rendererRoot = path.join(root, "src", "renderer");
const themeFile = path.join(rendererRoot, "styles", "app-theme.css");
const appViewsFile = path.join(rendererRoot, "styles", "app-views.css");
const textExtensions = new Set([".css", ".html", ".js", ".jsx", ".ts", ".tsx"]);
const ignoredDirectories = new Set([".git", "dist", "node_modules", "out", "signed"]);
const ignoredExtensions = new Set([".avif", ".gif", ".ico", ".jpeg", ".jpg", ".png", ".svg", ".webp", ".woff", ".woff2"]);
const runtimeCustomProperties = new Set([
  "--bar-height",
  "--chat-thread-width",
  "--radix-popover-content-available-height",
  "--radix-popover-trigger-width",
  "--segmented-tabs-count",
  "--segmented-tabs-min-item-width",
  "--thread-width"
]);
const customPropertyDefinitions = new Set();
const customPropertyUsages = [];
const violations = [];

if (fs.existsSync(appViewsFile)) {
  violations.push(`${relative(appViewsFile)}: legacy app-views.css must not exist`);
}

scan(rendererRoot);
validateCssVariables();

if (violations.length > 0) {
  console.error("Renderer style guardrails failed:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log("Renderer style guardrails passed.");

function scan(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        scan(filePath);
      }
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    inspectFile(filePath);
  }
}

function inspectFile(filePath) {
  const extension = path.extname(filePath);
  if (ignoredExtensions.has(extension) || !textExtensions.has(extension)) {
    return;
  }
  const source = fs.readFileSync(filePath, "utf8");
  const isThemeFile = path.resolve(filePath) === path.resolve(themeFile);
  if (extension === ".css") {
    collectCustomProperties(filePath, source);
  }
  addMatches(filePath, source, /app-views(?:\.css)?/g, "legacy app-views reference");
  if (!isThemeFile) {
    addMatches(filePath, source, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g, "hardcoded color outside app-theme.css");
  }
}

function collectCustomProperties(filePath, source) {
  const definitionPattern = /--[a-zA-Z0-9_-]+(?=\s*:)/g;
  let definition = definitionPattern.exec(source);
  while (definition) {
    customPropertyDefinitions.add(definition[0]);
    definition = definitionPattern.exec(source);
  }

  const usagePattern = /var\((--[a-zA-Z0-9_-]+)/g;
  let usage = usagePattern.exec(source);
  while (usage) {
    customPropertyUsages.push({ filePath, name: usage[1], index: usage.index });
    usage = usagePattern.exec(source);
  }
}

function validateCssVariables() {
  const reported = new Set();
  for (const usage of customPropertyUsages) {
    if (customPropertyDefinitions.has(usage.name) || runtimeCustomProperties.has(usage.name)) {
      continue;
    }
    const key = `${usage.filePath}:${usage.name}`;
    if (reported.has(key)) {
      continue;
    }
    reported.add(key);
    const { line, column } = locationFor(fs.readFileSync(usage.filePath, "utf8"), usage.index);
    violations.push(`${relative(usage.filePath)}:${line}:${column}: undefined CSS custom property: ${usage.name}`);
  }
}

function addMatches(filePath, source, pattern, label) {
  pattern.lastIndex = 0;
  let match = pattern.exec(source);
  while (match) {
    const { line, column } = locationFor(source, match.index);
    violations.push(`${relative(filePath)}:${line}:${column}: ${label}: ${match[0]}`);
    match = pattern.exec(source);
  }
}

function locationFor(source, index) {
  const before = source.slice(0, index);
  const lines = before.split("\n");
  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1
  };
}

function relative(filePath) {
  return path.relative(root, filePath);
}
