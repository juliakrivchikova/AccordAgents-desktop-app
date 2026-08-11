#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync
} from "node:fs";
import path from "node:path";
import process from "node:process";

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

function verifyEnvironment() {
  if (process.platform !== "darwin") {
    fail(`Beta releases require macOS; current platform is ${process.platform}`);
  }
  if (process.arch !== "arm64") {
    fail(`Beta releases require native arm64 Node; current architecture is ${process.arch}`);
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

  const arm64RollupPackage = path.join(
    nodeModulesPath,
    "@rollup",
    "rollup-darwin-arm64",
    "package.json"
  );
  if (!existsSync(arm64RollupPackage)) {
    fail("arm64 Rollup native package is missing; rerun npm ci under native arm64 Node");
  }

  pass(
    `real local node_modules with ${productionDependencies.length} production and ${developmentDependencies.length} development dependencies`
  );
}

async function verifyPackagedApp(appArgument) {
  if (!appArgument) {
    fail("Usage: verify-release.mjs packaged /path/to/AccordAgents.app");
  }

  const packageJson = readRootPackageJson();
  const appPath = path.resolve(rootDir, appArgument);
  const asarPath = path.join(appPath, "Contents", "Resources", "app.asar");
  if (!existsSync(asarPath)) {
    fail(`Packaged app.asar not found: ${asarPath}`);
  }

  const { extractFile, listPackage } = await import("@electron/asar");
  const packagedFiles = new Set(listPackage(asarPath, {}));
  const requiredFiles = [
    "/package.json",
    "/dist/main/main/main.js",
    "/dist/main/main/services/appUpdater.js"
  ];
  for (const dependency of Object.keys(packageJson.dependencies || {})) {
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
}

const [command, argument] = process.argv.slice(2);
if (command === "environment") {
  verifyEnvironment();
} else if (command === "preflight") {
  verifyPreflight();
} else if (command === "packaged") {
  await verifyPackagedApp(argument);
} else {
  fail("Usage: verify-release.mjs <environment|preflight|packaged> [AccordAgents.app path]");
}
