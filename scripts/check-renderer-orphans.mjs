import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const srcRoot = path.join(root, "src");
const rendererRoot = path.join(srcRoot, "renderer");
const appRoots = [
  rendererRoot,
  path.join(srcRoot, "components")
];
const entrypoints = [
  path.join(rendererRoot, "App.tsx"),
  path.join(rendererRoot, "styles", "app.css")
];
const extensions = [".ts", ".tsx", ".js", ".jsx", ".css"];
const extensionSet = new Set(extensions);
const sourceFiles = [];

walk(srcRoot);

const fileSet = new Set(sourceFiles);
const reachable = new Set();
const stack = entrypoints.filter((filePath) => fileSet.has(filePath));

while (stack.length > 0) {
  const filePath = stack.pop();
  if (!filePath || reachable.has(filePath)) {
    continue;
  }
  reachable.add(filePath);
  for (const dependency of importsOf(filePath)) {
    if (!reachable.has(dependency)) {
      stack.push(dependency);
    }
  }
}

const appFiles = sourceFiles.filter((filePath) =>
  appRoots.some((appRoot) => filePath.startsWith(`${appRoot}${path.sep}`))
  && !/\.(?:test|spec)\.[^.]+$/.test(filePath)
);
const unreachable = appFiles.filter((filePath) => !reachable.has(filePath)).sort();

if (unreachable.length > 0) {
  console.error("Renderer orphan file check failed:");
  for (const filePath of unreachable) {
    console.error(`- ${relative(filePath)}`);
  }
  process.exit(1);
}

console.log("Renderer orphan file check passed.");

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (![".git", "dist", "node_modules", "out", "signed"].includes(entry.name)) {
        walk(filePath);
      }
      continue;
    }
    if (entry.isFile() && extensionSet.has(path.extname(filePath))) {
      sourceFiles.push(filePath);
    }
  }
}

function importsOf(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const specs = [];
  const patterns = [
    /import\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?["']([^"']+)["']/g,
    /export\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)["']([^"']+)["']/g,
    /import\(\s*["']([^"']+)["']\s*\)/g,
    /@import\s+["']([^"']+)["']/g,
    /url\(\s*["']?([^"')]+)["']?\s*\)/g
  ];

  for (const pattern of patterns) {
    let match = pattern.exec(source);
    while (match) {
      specs.push(match[1]);
      match = pattern.exec(source);
    }
  }

  return specs.flatMap((spec) => resolveImport(filePath, spec));
}

function resolveImport(fromFile, spec) {
  let basePath;
  if (spec.startsWith("@/")) {
    basePath = path.join(srcRoot, spec.slice(2));
  } else if (spec.startsWith("./") || spec.startsWith("../")) {
    basePath = path.resolve(path.dirname(fromFile), spec);
  } else {
    return [];
  }

  const resolved = [];
  if (fileSet.has(basePath)) {
    resolved.push(basePath);
  }
  for (const extension of extensions) {
    if (fileSet.has(`${basePath}${extension}`)) {
      resolved.push(`${basePath}${extension}`);
    }
  }
  for (const extension of extensions) {
    const indexPath = path.join(basePath, `index${extension}`);
    if (fileSet.has(indexPath)) {
      resolved.push(indexPath);
    }
  }
  return resolved;
}

function relative(filePath) {
  return path.relative(root, filePath);
}
