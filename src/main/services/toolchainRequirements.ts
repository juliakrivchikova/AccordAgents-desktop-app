import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export type ToolchainRequirementSeverity = "required" | "advisory";
export type ToolchainIssueCategory = "missing" | "unsupported" | "probe";
export type ToolchainRemediationKind = "worker_setup" | "manual";

export interface ToolchainRemediation {
  kind: ToolchainRemediationKind;
  message: string;
  command?: string;
}

export interface ToolchainRequirement {
  tool: string;
  label: string;
  command: string;
  alternativeCommands?: string[];
  severity: ToolchainRequirementSeverity;
  sources: string[];
  // Health probe only. v1 does not parse repo-specific version constraints
  // such as JDK 17 vs 21, Gradle versions, .tool-versions, or wrappers.
  probeCommand?: string;
  unsupportedOnLinux?: boolean;
  remediation: ToolchainRemediation;
}

export interface ToolchainPreflightIssue {
  tool: string;
  label: string;
  severity: ToolchainRequirementSeverity;
  category: ToolchainIssueCategory;
  detail: string;
  sources: string[];
  remediation: ToolchainRemediation;
}

export interface ToolchainDetectionOptions {
  maxDepth?: number;
}

interface DetectedManifest {
  relativePath: string;
  name: string;
}

const DEFAULT_SCAN_DEPTH = 2;
const EXCLUDED_SCAN_DIRS = new Set([
  ".git",
  ".gradle",
  ".idea",
  ".next",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor"
]);

export class RemoteRunPreflightError extends Error {
  readonly issues: ToolchainPreflightIssue[];

  constructor(issues: ToolchainPreflightIssue[]) {
    super(formatToolchainPreflightIssues(issues));
    this.name = "RemoteRunPreflightError";
    this.issues = issues;
  }
}

export class RemoteRunPreflightInfrastructureError extends Error {
  constructor(message: string) {
    super(`Remote worker environment preflight could not complete: ${message}`);
    this.name = "RemoteRunPreflightInfrastructureError";
  }
}

export async function detectRepoToolchainRequirements(
  repoRoot: string | undefined,
  options: ToolchainDetectionOptions = {}
): Promise<ToolchainRequirement[]> {
  if (!repoRoot) {
    return [];
  }
  const root = path.resolve(repoRoot);
  try {
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }

  const manifests = await scanManifests(root, Math.max(0, Math.floor(options.maxDepth ?? DEFAULT_SCAN_DEPTH)));
  return requirementsFromManifests(manifests);
}

export function formatToolchainPreflightIssues(issues: readonly ToolchainPreflightIssue[]): string {
  const blocking = issues.filter((issue) => issue.severity === "required");
  if (blocking.length === 0) {
    return "";
  }
  const lines = blocking.map((issue) => {
    const sourceText = issue.sources.length > 0 ? ` Sources: ${issue.sources.join(", ")}.` : "";
    return `- ${issue.label}: ${issue.detail}${sourceText} ${issue.remediation.message}`.trim();
  });
  return [
    "Remote worker is missing required tooling for this repository.",
    ...lines
  ].join("\n");
}

export function formatToolchainAdvisoryIssues(issues: readonly ToolchainPreflightIssue[]): string {
  const advisory = issues.filter((issue) => issue.severity === "advisory");
  if (advisory.length === 0) {
    return "";
  }
  const lines = advisory.map((issue) => {
    const sourceText = issue.sources.length > 0 ? ` Sources: ${issue.sources.join(", ")}.` : "";
    return `${issue.label}: ${issue.detail}${sourceText} ${issue.remediation.message}`.trim();
  });
  return `Remote worker advisory: ${lines.join(" ")}`;
}

export function issueFromRequirement(
  requirement: ToolchainRequirement,
  category: ToolchainIssueCategory,
  detail?: string
): ToolchainPreflightIssue {
  return {
    tool: requirement.tool,
    label: requirement.label,
    severity: requirement.severity,
    category,
    detail: detail ?? defaultIssueDetail(requirement, category),
    sources: requirement.sources,
    remediation: requirement.remediation
  };
}

function requirementsFromManifests(manifests: DetectedManifest[]): ToolchainRequirement[] {
  const byName = new Map<string, DetectedManifest[]>();
  for (const manifest of manifests) {
    const current = byName.get(manifest.name) ?? [];
    current.push(manifest);
    byName.set(manifest.name, current);
  }

  const requirements = new Map<string, ToolchainRequirement>();
  const add = (requirement: Omit<ToolchainRequirement, "sources">, sources: DetectedManifest[]): void => {
    if (sources.length === 0) {
      return;
    }
    const existing = requirements.get(requirement.tool);
    const nextSources = sources.map((source) => source.relativePath).sort();
    if (!existing) {
      requirements.set(requirement.tool, { ...requirement, sources: nextSources });
      return;
    }
    const mergedSeverity = existing.severity === "required" || requirement.severity === "required"
      ? "required"
      : "advisory";
    requirements.set(requirement.tool, {
      ...existing,
      ...requirement,
      severity: mergedSeverity,
      sources: [...new Set([...existing.sources, ...nextSources])].sort()
    });
  };
  const sources = (...names: string[]): DetectedManifest[] =>
    names.flatMap((name) => byName.get(name) ?? []);
  const anyName = (...names: string[]): boolean => sources(...names).length > 0;

  const mavenSources = sources("pom.xml", "mvnw", ".mvn");
  const gradleSources = sources("build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "gradlew");
  add(requirement("java", "Java/JDK", "java", "required", "java -version", {
    command: "sudo apt-get install -y openjdk-21-jdk",
    message: "Install OpenJDK on the worker, or run the worker setup action for an app-managed AWS worker."
  }), [...mavenSources, ...gradleSources]);
  if (mavenSources.length > 0 && !anyName("mvnw")) {
    add(requirement("maven", "Maven", "mvn", "required", "mvn -version", {
      command: "sudo apt-get install -y maven",
      message: "Install Maven on the worker, or use the repository Maven wrapper."
    }), mavenSources);
  }
  if (gradleSources.length > 0 && !anyName("gradlew")) {
    add(requirement("gradle", "Gradle", "gradle", "required", "gradle -version", {
      command: "sudo apt-get install -y gradle",
      message: "Install Gradle on the worker, or use the repository Gradle wrapper."
    }), gradleSources);
  }

  add(requirement("node", "Node.js", "node", "required", "node --version", {
    command: "sudo apt-get install -y nodejs",
    message: "Install Node.js on the worker, or run the worker setup action for an app-managed AWS worker."
  }), sources("package.json"));
  add(requirement("npm", "npm", "npm", "required", "npm --version", {
    message: "Install npm on the worker with Node.js."
  }), sources("package-lock.json", "npm-shrinkwrap.json"));
  add(requirement("pnpm", "pnpm", "pnpm", "required", "pnpm --version", {
    command: "sudo npm install -g pnpm",
    message: "Install pnpm on the worker, or enable it through corepack when Node.js provides corepack."
  }, false, ["corepack"]), sources("pnpm-lock.yaml"));
  add(requirement("yarn", "Yarn", "yarn", "required", "yarn --version", {
    command: "sudo npm install -g yarn",
    message: "Install Yarn on the worker, or enable it through corepack when Node.js provides corepack."
  }, false, ["corepack"]), sources("yarn.lock"));
  add(requirement("bun", "Bun", "bun", "required", "bun --version", {
    message: "Install Bun on the worker."
  }), sources("bun.lock", "bun.lockb"));

  add(requirement("python3", "Python 3", "python3", "required", "python3 --version", {
    command: "sudo apt-get install -y python3 python3-venv python3-pip",
    message: "Install Python 3 on the worker."
  }), sources("pyproject.toml", "requirements.txt", "poetry.lock"));
  add(requirement("go", "Go", "go", "required", "go version", {
    command: "sudo apt-get install -y golang-go",
    message: "Install Go on the worker."
  }), sources("go.mod"));
  add(requirement("cargo", "Rust/Cargo", "cargo", "required", "cargo --version", {
    command: "sudo apt-get install -y cargo",
    message: "Install Rust/Cargo on the worker."
  }), sources("Cargo.toml"));
  add(requirement("ruby", "Ruby", "ruby", "required", "ruby --version", {
    command: "sudo apt-get install -y ruby-full",
    message: "Install Ruby on the worker."
  }), sources("Gemfile"));
  add(requirement("make", "make", "make", "advisory", "make --version", {
    command: "sudo apt-get install -y make",
    message: "Install make on the worker if this repository's verification depends on the Makefile."
  }), sources("Makefile", "makefile", "GNUmakefile"));
  add(requirement("xcodebuild", "Xcode build tools", "xcodebuild", "required", undefined, {
    kind: "manual",
    message: "Use a macOS runner for Xcode projects; Linux workers cannot provide xcodebuild."
  }, true), sourcesByExtension(manifests, ".xcodeproj", ".xcworkspace"));

  return [...requirements.values()].sort((first, second) => first.tool.localeCompare(second.tool));
}

function requirement(
  tool: string,
  label: string,
  command: string,
  severity: ToolchainRequirementSeverity,
  probeCommand: string | undefined,
  remediation: Omit<ToolchainRemediation, "kind"> & { kind?: ToolchainRemediationKind },
  unsupportedOnLinux = false,
  alternativeCommands: string[] = []
): Omit<ToolchainRequirement, "sources"> {
  return {
    tool,
    label,
    command,
    alternativeCommands,
    severity,
    probeCommand,
    unsupportedOnLinux,
    remediation: {
      kind: remediation.kind ?? "worker_setup",
      message: remediation.message,
      command: remediation.command
    }
  };
}

function sourcesByExtension(manifests: DetectedManifest[], ...extensions: string[]): DetectedManifest[] {
  return manifests.filter((manifest) => extensions.some((extension) => manifest.name.endsWith(extension)));
}

async function scanManifests(root: string, maxDepth: number): Promise<DetectedManifest[]> {
  const manifests: DetectedManifest[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (isManifestName(entry.name)) {
        manifests.push({
          name: entry.name,
          relativePath: path.relative(root, absolute) || entry.name
        });
      }
      if (!entry.isDirectory() || depth >= maxDepth || EXCLUDED_SCAN_DIRS.has(entry.name)) {
        continue;
      }
      await visit(absolute, depth + 1);
    }
  };
  await visit(root, 0);
  return manifests;
}

function isManifestName(name: string): boolean {
  return name === "pom.xml" ||
    name === "mvnw" ||
    name === ".mvn" ||
    name === "build.gradle" ||
    name === "build.gradle.kts" ||
    name === "settings.gradle" ||
    name === "settings.gradle.kts" ||
    name === "gradlew" ||
    name === "package.json" ||
    name === "package-lock.json" ||
    name === "npm-shrinkwrap.json" ||
    name === "pnpm-lock.yaml" ||
    name === "yarn.lock" ||
    name === "bun.lock" ||
    name === "bun.lockb" ||
    name === "pyproject.toml" ||
    name === "requirements.txt" ||
    name === "poetry.lock" ||
    name === "go.mod" ||
    name === "Cargo.toml" ||
    name === "Gemfile" ||
    name === "Makefile" ||
    name === "makefile" ||
    name === "GNUmakefile" ||
    name.endsWith(".xcodeproj") ||
    name.endsWith(".xcworkspace");
}

function defaultIssueDetail(requirement: ToolchainRequirement, category: ToolchainIssueCategory): string {
  if (category === "unsupported") {
    return `${requirement.label} is not available on Linux remote workers.`;
  }
  if (category === "probe") {
    return `${requirement.label} is present but failed its health check.`;
  }
  return `${requirement.label} is not available on the remote worker.`;
}
