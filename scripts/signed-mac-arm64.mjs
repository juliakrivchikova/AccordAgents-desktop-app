#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import process from "node:process";

const rootDir = process.cwd();
const envPath = path.join(rootDir, ".env.local");
const outDir = path.join(rootDir, "out");
const signedDir = path.join(rootDir, "signed");
const packageJson = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
const productName = packageJson.productName || packageJson.name;
const version = packageJson.version;
const appPath = path.join(outDir, `${productName}-darwin-arm64`, `${productName}.app`);
const makeDir = path.join(outDir, "make");
const requiredEnv = [
  "APPLE_CODESIGN_IDENTITY",
  "APPLE_TEAM_ID",
  "APPLE_NOTARIZE_APPLE_ID",
  "APPLE_NOTARIZE_PASSWORD",
  "MACOS_BUNDLE_ID"
];

function log(message) {
  console.log(`\n==> ${message}`);
}

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

function loadEnvLocal() {
  if (!existsSync(envPath)) {
    return;
  }

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const normalized = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, separatorIndex).trim();
    let value = normalized.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: rootDir,
    env: process.env,
    stdio: options.stdio || "inherit"
  });
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runWithRetry(command, args, options = {}) {
  const attempts = options.attempts ?? 3;
  const delayMs = options.delayMs ?? 10_000;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawnSync(command, args, {
      cwd: rootDir,
      env: process.env,
      encoding: "utf8"
    });
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    if (!result.error && result.status === 0) {
      return;
    }
    if (attempt === attempts) {
      const details = result.error instanceof Error ? result.error.message : `${command} exited with status ${result.status}`;
      fail(`Command failed after ${attempts} attempts: ${details}`);
    }
    console.warn(`Command failed; retrying in ${Math.round(delayMs / 1000)}s (${attempt}/${attempts}).`);
    sleep(delayMs);
  }
}

function output(command, args) {
  return execFileSync(command, args, {
    cwd: rootDir,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function combinedOutput(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    env: process.env,
    encoding: "utf8"
  });
  return {
    status: result.status,
    output: `${result.stdout || ""}${result.stderr || ""}`
  };
}

function requireCommand(command, args = ["--version"]) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    env: process.env,
    encoding: "utf8"
  });

  if (result.error || result.status !== 0) {
    fail(`Required command is unavailable or failed: ${command}`);
  }
}

function validateEnvironment() {
  if (process.platform !== "darwin") {
    fail("Signed macOS builds must run on macOS.");
  }

  requireCommand("xcode-select", ["-p"]);
  requireCommand("xcrun", ["notarytool", "--version"]);
  requireCommand("xcrun", ["-f", "stapler"]);
  requireCommand("security", ["find-identity", "-p", "codesigning", "-v"]);

  const missing = requiredEnv.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    fail(`Missing required .env.local values: ${missing.join(", ")}`);
  }

  const identity = process.env.APPLE_CODESIGN_IDENTITY;
  const teamId = process.env.APPLE_TEAM_ID;
  if (!identity.startsWith("Developer ID Application:")) {
    fail("APPLE_CODESIGN_IDENTITY must be a Developer ID Application identity.");
  }
  if (!identity.includes(`(${teamId})`)) {
    fail("APPLE_CODESIGN_IDENTITY must include the APPLE_TEAM_ID in parentheses.");
  }

  const identities = output("security", ["find-identity", "-p", "codesigning", "-v"]);
  if (!identities.includes(`"${identity}"`)) {
    fail(`Could not find APPLE_CODESIGN_IDENTITY in the macOS keychain: ${identity}`);
  }
}

function ensureDmgNativeDependencies() {
  const result = spawnSync(process.execPath, ["-e", "require('macos-alias')"], {
    cwd: rootDir,
    env: process.env,
    encoding: "utf8"
  });

  if (!result.error && result.status === 0) {
    return;
  }

  const output = `${result.stdout || ""}${result.stderr || ""}`;
  const shouldRebuild =
    output.includes("NODE_MODULE_VERSION") ||
    output.includes("Module did not self-register") ||
    output.includes("was compiled against a different Node.js version");

  if (!shouldRebuild) {
    fail(`Could not load macos-alias, which is required by the DMG maker:\n${output}`);
  }

  log("Rebuilding macos-alias for the current Node.js version");
  run("npm", ["rebuild", "macos-alias"]);
}

function cleanOutputs() {
  rmSync(outDir, { recursive: true, force: true });
  rmSync(signedDir, { recursive: true, force: true });
  mkdirSync(signedDir, { recursive: true });
}

function findDmg() {
  if (!existsSync(makeDir)) {
    fail("Forge did not create out/make.");
  }

  const dmgs = [];
  const walk = (directory) => {
    for (const entryName of readdirSync(directory)) {
      const entryPath = path.join(directory, entryName);
      const stats = statSync(entryPath);
      if (stats.isDirectory()) {
        walk(entryPath);
      } else if (stats.isFile() && entryPath.endsWith(".dmg") && entryPath.includes("-arm64")) {
        dmgs.push(entryPath);
      }
    }
  };
  walk(makeDir);

  if (dmgs.length !== 1) {
    fail(`Expected exactly one arm64 DMG in out/make, found ${dmgs.length}.`);
  }

  return dmgs[0];
}

function verifySignedApp() {
  if (!existsSync(appPath)) {
    fail(`Expected app bundle was not created: ${appPath}`);
  }

  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);

  const details = combinedOutput("codesign", ["-dvvv", appPath]);
  if (details.status !== 0) {
    fail(`Could not inspect code signature:\n${details.output}`);
  }
  if (details.output.includes("Signature=adhoc")) {
    fail("The app was ad hoc signed instead of Developer ID signed.");
  }
  if (!details.output.includes("Authority=Developer ID Application")) {
    fail("The app signature is not a Developer ID Application signature.");
  }
  if (!details.output.includes(`TeamIdentifier=${process.env.APPLE_TEAM_ID}`)) {
    fail("The app signature TeamIdentifier does not match APPLE_TEAM_ID.");
  }

  run("xcrun", ["stapler", "staple", appPath]);
  run("xcrun", ["stapler", "validate", appPath]);
  run("spctl", ["-a", "-vv", "--type", "exec", appPath]);
}

function notarizeAndVerifyDmg(dmgPath) {
  runWithRetry("codesign", [
    "--force",
    "--timestamp",
    "--sign",
    process.env.APPLE_CODESIGN_IDENTITY,
    dmgPath
  ], { attempts: 4, delayMs: 15_000 });
  run("codesign", ["--verify", "--verbose=2", dmgPath]);

  run("xcrun", [
    "notarytool",
    "submit",
    dmgPath,
    "--apple-id",
    process.env.APPLE_NOTARIZE_APPLE_ID,
    "--team-id",
    process.env.APPLE_TEAM_ID,
    "--password",
    process.env.APPLE_NOTARIZE_PASSWORD,
    "--wait"
  ]);

  run("xcrun", ["stapler", "staple", dmgPath]);
  run("xcrun", ["stapler", "validate", dmgPath]);
  run("spctl", ["-a", "-vv", "--type", "open", "--context", "context:primary-signature", dmgPath]);
}

function sha256(filePath) {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

function writeChecksum(filePath) {
  const checksumPath = `${filePath}.sha256`;
  writeFileSync(checksumPath, `${sha256(filePath)}  ${path.basename(filePath)}\n`);
  return checksumPath;
}

function copySignedDmg(dmgPath) {
  const signedDmgPath = path.join(signedDir, path.basename(dmgPath));
  copyFileSync(dmgPath, signedDmgPath);

  const checksumPath = writeChecksum(signedDmgPath);

  return { signedDmgPath, checksumPath };
}

function createSignedZip() {
  const signedZipPath = path.join(signedDir, `${productName}-${version}-darwin-arm64.zip`);
  rmSync(signedZipPath, { force: true });
  rmSync(`${signedZipPath}.sha256`, { force: true });

  run("ditto", [
    "-c",
    "-k",
    "--sequesterRsrc",
    "--keepParent",
    appPath,
    signedZipPath
  ]);

  if (!existsSync(signedZipPath) || statSync(signedZipPath).size === 0) {
    fail(`Expected signed ZIP was not created: ${signedZipPath}`);
  }

  const checksumPath = writeChecksum(signedZipPath);
  return { signedZipPath, checksumPath };
}

loadEnvLocal();

log("Validating local signing environment");
validateEnvironment();

ensureDmgNativeDependencies();

log("Cleaning previous build outputs");
cleanOutputs();

log("Running TypeScript checks");
run("npm", ["run", "typecheck"]);

log("Building macOS arm64 distributables with Electron Forge");
run("npm", ["run", "make", "--", "--platform=darwin", "--arch=arm64"]);

log("Verifying signed and notarized app bundle");
verifySignedApp();

log("Creating signed ZIP for macOS auto-updates");
const { signedZipPath, checksumPath: zipChecksumPath } = createSignedZip();

const dmgPath = findDmg();

log("Notarizing and stapling DMG");
notarizeAndVerifyDmg(dmgPath);

log("Copying signed DMG into signed/");
const { signedDmgPath, checksumPath } = copySignedDmg(dmgPath);

console.log(`\nSigned DMG: ${path.relative(rootDir, signedDmgPath)}`);
console.log(`Checksum: ${path.relative(rootDir, checksumPath)}`);
console.log(`Signed ZIP: ${path.relative(rootDir, signedZipPath)}`);
console.log(`Checksum: ${path.relative(rootDir, zipChecksumPath)}`);
