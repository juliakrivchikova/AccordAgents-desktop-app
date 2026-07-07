import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { detectRepoToolchainRequirements, formatToolchainPreflightIssues, issueFromRequirement } from "./toolchainRequirements";
import type { ToolchainRequirement } from "./toolchainRequirements";

test("detects Java and Maven for a Maven repository without wrapper", async () => {
  const repo = await fixture({ "pom.xml": "<project />" });

  const requirements = await detectRepoToolchainRequirements(repo);

  assert.deepEqual(tools(requirements), ["java", "maven"]);
  assert.equal(requirements.find((requirement) => requirement.tool === "java")?.severity, "required");
});

test("Maven and Gradle wrappers skip global build tools but still require Java", async () => {
  const repo = await fixture({
    "pom.xml": "<project />",
    "mvnw": "",
    "build.gradle.kts": "",
    "gradlew": ""
  });

  const requirements = await detectRepoToolchainRequirements(repo);

  assert.deepEqual(tools(requirements), ["java"]);
});

test("detects Node package managers from lockfiles", async () => {
  const repo = await fixture({
    "package.json": "{}",
    "pnpm-lock.yaml": "",
    "yarn.lock": "",
    "bun.lockb": ""
  });

  const requirements = await detectRepoToolchainRequirements(repo);

  assert.deepEqual(tools(requirements), ["bun", "node", "pnpm", "yarn"]);
  assert.deepEqual(requirements.find((requirement) => requirement.tool === "pnpm")?.alternativeCommands, ["corepack"]);
  assert.deepEqual(requirements.find((requirement) => requirement.tool === "yarn")?.alternativeCommands, ["corepack"]);
});

test("detects common non-Java toolchains", async () => {
  const repo = await fixture({
    "pyproject.toml": "",
    "go.mod": "",
    "Cargo.toml": "",
    "Gemfile": ""
  });

  const requirements = await detectRepoToolchainRequirements(repo);

  assert.deepEqual(tools(requirements), ["cargo", "go", "python3", "ruby"]);
});

test("Makefile is advisory instead of blocking by default", async () => {
  const repo = await fixture({ "Makefile": "test:\n\ttrue\n" });

  const requirements = await detectRepoToolchainRequirements(repo);

  assert.deepEqual(tools(requirements), ["make"]);
  assert.equal(requirements[0].severity, "advisory");
});

test("Xcode projects are required but unsupported on Linux workers", async () => {
  const repo = await fixture({ "App.xcodeproj/project.pbxproj": "" });

  const requirements = await detectRepoToolchainRequirements(repo);

  assert.deepEqual(tools(requirements), ["xcodebuild"]);
  assert.equal(requirements[0].unsupportedOnLinux, true);
});

test("scans shallow monorepo subdirectories and skips excluded dependency dirs", async () => {
  const repo = await fixture({
    "services/api/pom.xml": "<project />",
    "node_modules/pkg/go.mod": "module ignored"
  });

  const requirements = await detectRepoToolchainRequirements(repo);

  assert.deepEqual(tools(requirements), ["java", "maven"]);
  assert.deepEqual(requirements.find((requirement) => requirement.tool === "java")?.sources, ["services/api/pom.xml"]);
});

test("empty or missing repositories produce no requirements", async () => {
  const repo = await fixture({});

  assert.deepEqual(await detectRepoToolchainRequirements(repo), []);
  assert.deepEqual(await detectRepoToolchainRequirements(path.join(repo, "missing")), []);
});

test("formats structured blocking issues with remediation", () => {
  const requirement: ToolchainRequirement = {
    tool: "java",
    label: "Java/JDK",
    command: "java",
    severity: "required",
    sources: ["pom.xml"],
    remediation: {
      kind: "worker_setup",
      message: "Install OpenJDK on the worker.",
      command: "sudo apt-get install -y openjdk-21-jdk"
    }
  };

  const message = formatToolchainPreflightIssues([issueFromRequirement(requirement, "missing")]);

  assert.match(message, /Remote worker is missing required tooling/);
  assert.match(message, /Java\/JDK/);
  assert.match(message, /pom\.xml/);
  assert.match(message, /Install OpenJDK/);
});

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "accordagents-toolchain-"));
  await Promise.all(Object.entries(files).map(async ([relativePath, content]) => {
    const absolutePath = path.join(root, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }));
  return root;
}

function tools(requirements: ToolchainRequirement[]): string[] {
  return requirements.map((requirement) => requirement.tool).sort();
}
