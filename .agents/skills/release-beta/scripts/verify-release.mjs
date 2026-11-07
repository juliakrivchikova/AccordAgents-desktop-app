#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const rootDir = process.cwd();
const packageJsonPath = path.join(rootDir, "package.json");

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function pass(message) {
  console.log(`PASS: ${message}`);
}

function readRootPackageJson() {
  if (!existsSync(packageJsonPath)) {
    fail(`Run from the AccordAgents repository root; missing ${packageJsonPath}`);
  }
  return JSON.parse(readFileSync(packageJsonPath, "utf8"));
}

function dependencyPath(nodeModulesPath, dependency) {
  return path.join(nodeModulesPath, ...dependency.split("/"));
}

function isInside(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function packagedRuntimeDependencies(packageJson) {
  const dependencies = Object.keys(packageJson.dependencies || {});
  // node-pty is loaded only by the Windows Claude model-picker path and is
  // intentionally excluded from non-Windows packages in forge.config.ts.
  return process.platform === "win32"
    ? dependencies
    : dependencies.filter((dependency) => dependency !== "node-pty");
}

// Each release platform is built on its own native machine and architecture.
const releasePlatforms = {
  darwin: { arch: "arm64", rollupPackage: "rollup-darwin-arm64" },
  win32: { arch: "x64", rollupPackage: "rollup-win32-x64-msvc" }
};

function verifyEnvironment() {
  const expected = releasePlatforms[process.platform];
  if (!expected) {
    fail(`Releases are built on macOS or Windows; current platform is ${process.platform}`);
  }
  if (process.arch !== expected.arch) {
    fail(`${process.platform} releases require native ${expected.arch} Node; current architecture is ${process.arch}`);
  }
  pass(`native ${process.platform} ${process.arch} Node ${process.version}`);
}

function verifyPreflight() {
  const packageJson = readRootPackageJson();
  verifyEnvironment();

  const nodeModulesPath = path.join(rootDir, "node_modules");
  if (!existsSync(nodeModulesPath)) {
    fail("node_modules is missing; run npm ci in this checkout");
  }
  const nodeModulesStat = lstatSync(nodeModulesPath);
  if (nodeModulesStat.isSymbolicLink()) {
    fail("node_modules is a symlink; run npm ci in this checkout instead");
  }
  if (!nodeModulesStat.isDirectory()) {
    fail("node_modules is not a directory");
  }

  const realNodeModulesPath = realpathSync(nodeModulesPath);
  const expectedNodeModulesPath = path.resolve(nodeModulesPath);
  if (realNodeModulesPath !== expectedNodeModulesPath) {
    fail(`node_modules resolves outside this checkout: ${realNodeModulesPath}`);
  }
  if (!existsSync(path.join(nodeModulesPath, ".package-lock.json"))) {
    fail("node_modules lacks npm's installation lock; run npm ci in this checkout");
  }

  const productionDependencies = Object.keys(packageJson.dependencies || {});
  const developmentDependencies = Object.keys(packageJson.devDependencies || {});
  const installedDependencies = [
    ...productionDependencies,
    ...developmentDependencies
  ];
  for (const dependency of installedDependencies) {
    const installedPath = dependencyPath(nodeModulesPath, dependency);
    if (!existsSync(path.join(installedPath, "package.json"))) {
      fail(`package dependency is not installed locally: ${dependency}`);
    }
    const realInstalledPath = realpathSync(installedPath);
    if (!isInside(realNodeModulesPath, realInstalledPath)) {
      fail(`package dependency resolves outside this checkout: ${dependency} -> ${realInstalledPath}`);
    }
  }

  const requiredBins = ["electron-forge", "tsc", "vite"];
  for (const requiredBin of requiredBins) {
    if (!existsSync(path.join(nodeModulesPath, ".bin", requiredBin))) {
      fail(`npm development binary is missing: node_modules/.bin/${requiredBin}`);
    }
  }

  const rollupNativePackage = releasePlatforms[process.platform].rollupPackage;
  if (!existsSync(path.join(nodeModulesPath, "@rollup", rollupNativePackage, "package.json"))) {
    fail(`${rollupNativePackage} is missing; rerun npm ci under native ${process.arch} Node`);
  }

  pass(
    `real local node_modules with ${productionDependencies.length} production and ${developmentDependencies.length} development dependencies`
  );
}

async function verifyPackagedApp(appArgument) {
  if (!appArgument) {
    fail("Usage: verify-release.mjs packaged <path/to/AccordAgents.app | packaged Windows folder>");
  }

  const packageJson = readRootPackageJson();
  const appPath = path.resolve(rootDir, appArgument);
  const asarPath = process.platform === "win32"
    ? path.join(appPath, "resources", "app.asar")
    : path.join(appPath, "Contents", "Resources", "app.asar");
  if (!existsSync(asarPath)) {
    fail(`Packaged app.asar not found: ${asarPath}`);
  }

  const { verifyRuntimeArchive } = await import(pathToFileURL(path.join(rootDir, "scripts", "packaging-boundary.mjs")).href);
  let packagedFiles;
  try {
    packagedFiles = new Set(verifyRuntimeArchive(asarPath));
  } catch (error) {
    fail(error.message);
  }
  pass("app.asar holds only runtime files");

  const { extractFile } = await import("@electron/asar");
  const requiredFiles = [
    "/package.json",
    "/dist/main/main/main.js",
    "/dist/main/main/services/appUpdater.js"
  ];
  for (const dependency of packagedRuntimeDependencies(packageJson)) {
    requiredFiles.push(`/node_modules/${dependency}/package.json`);
  }
  for (const requiredFile of requiredFiles) {
    if (!packagedFiles.has(requiredFile)) {
      fail(`Packaged app is missing ${requiredFile}`);
    }
  }

  const packagedPackageJson = JSON.parse(extractFile(asarPath, "package.json").toString("utf8"));
  if (packagedPackageJson.version !== packageJson.version) {
    fail(`Packaged version ${packagedPackageJson.version} does not match checkout version ${packageJson.version}`);
  }

  pass(`app.asar contains all ${requiredFiles.length} required runtime entries`);
  pass(`packaged version matches ${packageJson.version}`);

  // Speech to text runs this program from the app's resources; a Mac app
  // built without it would offer the feature and fail when it is turned on.
  if (process.platform === "darwin") {
    const engine = path.join(appPath, "Contents", "Resources", "whisper", "whisper-server");
    if (!existsSync(engine)) {
      fail(`Packaged app is missing the speech-to-text engine: ${engine}`);
    }
    pass("speech-to-text engine is packaged");
  }
}

const [command, argument] = process.argv.slice(2);
if (command === "environment") {
  verifyEnvironment();
} else if (command === "preflight") {
  verifyPreflight();
} else if (command === "packaged") {
  await verifyPackagedApp(argument);
} else {
  fail("Usage: verify-release.mjs <environment|preflight|packaged> [AccordAgents.app path | packaged Windows folder]");
}
