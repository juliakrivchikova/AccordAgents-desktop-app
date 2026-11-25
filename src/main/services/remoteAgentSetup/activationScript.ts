import { PORTABLE_SETUP_RETENTION_MS } from "./constants";

export function remotePortableSetupActivationScript(): string {
  return String.raw`const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const bundleRoot = path.resolve(process.argv[3]);
const statePath = path.resolve(process.argv[4]);
const manifest = JSON.parse(fs.readFileSync(path.join(bundleRoot, "manifest.json"), "utf8"));
if (manifest.version !== 1 || !Array.isArray(manifest.links) ||
    typeof manifest.fingerprint !== "string" || typeof manifest.sourceFingerprint !== "string") {
  throw new Error("invalid-portable-setup-manifest");
}
const home = os.homedir();
const roots = {
  codex: path.resolve(process.env.CODEX_HOME || path.join(home, ".codex")),
  agents: path.resolve(path.join(home, ".agents")),
  claude: path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude")),
  gemini: path.resolve(path.join(home, ".gemini", "config"))
};
const setupRoot = path.dirname(statePath);
const bundlesRoot = path.join(setupRoot, "bundles");
const backupRoot = path.join(setupRoot, "backups");
const lockPath = path.join(setupRoot, ".activation-lock");
const retentionMs = ${PORTABLE_SETUP_RETENTION_MS};
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } };
const inside = (root, candidate) => candidate === root || candidate.startsWith(root + path.sep);
const insideAnyRoot = (candidate) => Object.values(roots).some((root) => inside(root, candidate));
const pathEntryExists = (target) => {
  try { fs.lstatSync(target); return true; }
  catch (error) { if (error.code !== "ENOENT") { throw error; } return false; }
};
const unlinkIfPresent = (target) => {
  try { fs.unlinkSync(target); return true; } catch (error) { if (error.code !== "ENOENT") { throw error; } return false; }
};
const symlinkTarget = (target) => path.resolve(path.dirname(target), fs.readlinkSync(target));
const legacySetupRoots = [];
const devicesRoot = path.join(home, ".accordagents", "remote-runs", "devices");
try {
  for (const device of fs.readdirSync(devicesRoot)) {
    legacySetupRoots.push(path.join(devicesRoot, device, "agent-setup"));
  }
} catch {}
const managedSetupRoots = [setupRoot, ...legacySetupRoots];
const isManagedSource = (source) => managedSetupRoots.some((root) => inside(root, source));
const isManagedBundle = (candidate) => managedSetupRoots.some((root) =>
  inside(path.join(root, "bundles"), candidate) || candidate === path.join(root, "bundle")
);
const isManagedRetiredRoot = (candidate) =>
  isManagedBundle(candidate) || legacySetupRoots.includes(candidate);
const bundleForSource = (source) => {
  for (const root of managedSetupRoots) {
    const legacy = path.join(root, "bundle");
    if (inside(legacy, source)) { return legacy; }
    const parent = path.join(root, "bundles");
    if (inside(parent, source)) {
      const first = path.relative(parent, source).split(path.sep)[0];
      if (first) { return path.join(parent, first); }
    }
  }
  return undefined;
};
const wait = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
fs.mkdirSync(setupRoot, { recursive: true, mode: 0o700 });
const lockDeadline = Date.now() + 55000;
while (true) {
  try {
    fs.mkdirSync(lockPath, { mode: 0o700 });
    break;
  } catch (error) {
    if (error.code !== "EEXIST") { throw error; }
    try {
      if (Date.now() - fs.statSync(lockPath).mtimeMs > 120000) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
    } catch {}
    if (Date.now() >= lockDeadline) { throw new Error("portable-setup-lock-timeout"); }
    wait(25);
  }
}
try {
  const previous = readJson(statePath);
  const previousLinks = new Map();
  for (const link of Array.isArray(previous.links) ? previous.links : []) {
    if (!link || typeof link !== "object" || typeof link.source !== "string" || typeof link.target !== "string") {
      throw new Error("invalid-portable-setup-state-link");
    }
    const source = path.resolve(link.source);
    const target = path.resolve(link.target);
    const backup = typeof link.backup === "string" ? path.resolve(link.backup) : undefined;
    if (!isManagedSource(source) || !insideAnyRoot(target) || (backup && !inside(backupRoot, backup))) {
      throw new Error("unsafe-portable-setup-state-link");
    }
    if (previousLinks.has(target)) { throw new Error("duplicate-portable-setup-state-target"); }
    previousLinks.set(target, { source, target, ...(backup ? { backup } : {}) });
  }
  const migratedLegacyRoots = new Set();
  for (const legacyRoot of legacySetupRoots) {
    const legacyStatePath = path.join(legacyRoot, "state.json");
    if (!fs.existsSync(legacyStatePath)) { continue; }
    const legacy = readJson(legacyStatePath);
    const rawLinks = Array.isArray(legacy.links) ? legacy.links : [];
    if (rawLinks.length === 0) { continue; }
    const imported = [];
    const claimedBackups = new Set();
    let safe = true;
    for (const link of rawLinks) {
      if (!link || typeof link !== "object" || typeof link.source !== "string" || typeof link.target !== "string") {
        safe = false;
        break;
      }
      const source = path.resolve(link.source);
      const target = path.resolve(link.target);
      const backup = typeof link.backup === "string" ? path.resolve(link.backup) : undefined;
      const legacyBackupRoot = path.join(legacyRoot, "backups");
      if (!inside(legacyRoot, source) || !insideAnyRoot(target) || !pathEntryExists(source) ||
          (backup && !inside(legacyBackupRoot, backup))) {
        safe = false;
        break;
      }
      if (backup) { claimedBackups.add(backup); }
      if (previousLinks.has(target)) { continue; }
      if (pathEntryExists(target)) {
        const current = fs.lstatSync(target);
        if (!current.isSymbolicLink() || symlinkTarget(target) !== source) {
          safe = false;
          break;
        }
      }
      imported.push({ source, target, ...(backup ? { backup } : {}) });
    }
    try {
      for (const name of fs.readdirSync(path.join(legacyRoot, "backups"))) {
        if (!claimedBackups.has(path.join(legacyRoot, "backups", name))) {
          safe = false;
          break;
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") { safe = false; }
    }
    if (!safe) { continue; }
    for (const link of imported) { previousLinks.set(link.target, link); }
    migratedLegacyRoots.add(legacyRoot);
  }
  const plannedTargets = new Set();
  const planned = manifest.links.map((link) => {
    if (!link || typeof link !== "object" || !roots[link.root] ||
        typeof link.source !== "string" || typeof link.target !== "string") {
      throw new Error("invalid-portable-setup-link");
    }
    const source = path.resolve(bundleRoot, link.source);
    const target = path.resolve(roots[link.root], link.target);
    if (!inside(bundleRoot, source) || !inside(roots[link.root], target) || !fs.existsSync(source)) {
      throw new Error("unsafe-portable-setup-link");
    }
    if (plannedTargets.has(target)) { throw new Error("duplicate-portable-setup-target"); }
    plannedTargets.add(target);
    return { source, target };
  });
  for (const old of previousLinks.values()) {
    if (!pathEntryExists(old.target)) { continue; }
    const current = fs.lstatSync(old.target);
    if (!current.isSymbolicLink() || symlinkTarget(old.target) !== old.source) {
      throw new Error("managed-portable-setup-target-modified:" + old.target);
    }
  }
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const temporary = statePath + ".tmp-" + process.pid;
  const undo = [];
  let committed = false;
  try {
  for (const old of previousLinks.values()) {
    if (!old.backup || inside(backupRoot, old.backup) || !pathEntryExists(old.backup)) { continue; }
    const migratedBackup = path.join(backupRoot, crypto.createHash("sha256").update(old.target).digest("hex"));
    if (pathEntryExists(migratedBackup)) { throw new Error("portable-setup-backup-conflict:" + migratedBackup); }
    fs.renameSync(old.backup, migratedBackup);
    const legacyBackup = old.backup;
    old.backup = migratedBackup;
    undo.push(() => {
      fs.renameSync(migratedBackup, legacyBackup);
      old.backup = legacyBackup;
    });
  }
  const nextTargets = new Set(planned.map((link) => link.target));
  const adoptedBundleRoots = new Set();
  for (const old of previousLinks.values()) {
    if (nextTargets.has(old.target)) { continue; }
    if (unlinkIfPresent(old.target)) {
      undo.push(() => fs.symlinkSync(old.source, old.target, fs.statSync(old.source).isDirectory() ? "dir" : "file"));
    }
    if (old.backup && pathEntryExists(old.backup) && !pathEntryExists(old.target)) {
      fs.mkdirSync(path.dirname(old.target), { recursive: true, mode: 0o700 });
      fs.renameSync(old.backup, old.target);
      undo.push(() => fs.renameSync(old.target, old.backup));
    }
  }
  const nextStateLinks = [];
  for (let index = 0; index < planned.length; index += 1) {
    const link = planned[index];
    const old = previousLinks.get(link.target);
    let backup = old && old.backup;
    if (!old && pathEntryExists(link.target)) {
      const existing = fs.lstatSync(link.target);
      const adoptManaged = existing.isSymbolicLink() && isManagedSource(symlinkTarget(link.target));
      if (adoptManaged) {
        const adoptedSource = symlinkTarget(link.target);
        const adoptedBundle = bundleForSource(adoptedSource);
        if (adoptedBundle && adoptedBundle !== bundleRoot) { adoptedBundleRoots.add(adoptedBundle); }
        unlinkIfPresent(link.target);
        undo.push(() => fs.symlinkSync(adoptedSource, link.target, fs.statSync(adoptedSource).isDirectory() ? "dir" : "file"));
      } else {
        backup = path.join(backupRoot, crypto.createHash("sha256").update(link.target).digest("hex"));
        if (pathEntryExists(backup)) { throw new Error("portable-setup-backup-conflict:" + backup); }
        fs.renameSync(link.target, backup);
        undo.push(() => fs.renameSync(backup, link.target));
      }
    }
    fs.mkdirSync(path.dirname(link.target), { recursive: true, mode: 0o700 });
    if (unlinkIfPresent(link.target) && old) {
      undo.push(() => fs.symlinkSync(old.source, old.target, fs.statSync(old.source).isDirectory() ? "dir" : "file"));
    }
    const temporaryLink = link.target + ".accordagents-" + process.pid + "-" + index;
    unlinkIfPresent(temporaryLink);
    fs.symlinkSync(link.source, temporaryLink, fs.statSync(link.source).isDirectory() ? "dir" : "file");
    fs.renameSync(temporaryLink, link.target);
    undo.push(() => unlinkIfPresent(link.target));
    nextStateLinks.push({ source: link.source, target: link.target, ...(backup ? { backup } : {}) });
  }
  const retired = Array.isArray(previous.retired) ? previous.retired.filter((entry) =>
    entry && typeof entry.root === "string" && typeof entry.retiredAt === "number" && isManagedRetiredRoot(path.resolve(entry.root))
  ).map((entry) => ({ root: path.resolve(entry.root), retiredAt: entry.retiredAt })) : [];
  for (const adoptedRoot of adoptedBundleRoots) {
    if (isManagedBundle(adoptedRoot) && !retired.some((entry) => entry.root === adoptedRoot)) {
      retired.push({ root: adoptedRoot, retiredAt: Date.now() });
    }
  }
  for (const legacyRoot of migratedLegacyRoots) {
    if (!retired.some((entry) => entry.root === legacyRoot)) {
      retired.push({ root: legacyRoot, retiredAt: Date.now() });
    }
  }
  if (typeof previous.fingerprint === "string" && previous.fingerprint !== manifest.fingerprint) {
    for (const old of previousLinks.values()) {
      const candidate = bundleForSource(old.source);
      if (candidate && candidate !== bundleRoot && isManagedBundle(candidate) && !retired.some((entry) => entry.root === candidate)) {
        retired.push({ root: candidate, retiredAt: Date.now() });
      }
    }
  }
  const nextState = {
    version: 1,
    fingerprint: manifest.fingerprint,
    sourceFingerprint: manifest.sourceFingerprint,
    links: nextStateLinks,
    retired
  };
  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporary, JSON.stringify(nextState) + "\n", { mode: 0o600 });
  fs.renameSync(temporary, statePath);
  committed = true;
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    if (!committed) {
      for (const rollback of undo.reverse()) { try { rollback(); } catch {} }
    }
    throw error;
  }
  try {
    const current = readJson(statePath);
    const activeRoots = new Set([bundleRoot]);
    for (const link of Array.isArray(current.links) ? current.links : []) {
      if (link && typeof link.source === "string") {
        const activeRoot = bundleForSource(path.resolve(link.source));
        if (activeRoot) { activeRoots.add(activeRoot); }
      }
    }
    const kept = [];
    for (const entry of Array.isArray(current.retired) ? current.retired : []) {
      const retiredRoot = entry && typeof entry.root === "string" ? path.resolve(entry.root) : "";
      const containsActiveRoot = [...activeRoots].some((activeRoot) => inside(retiredRoot, activeRoot));
      if (!retiredRoot || !isManagedRetiredRoot(retiredRoot) || retiredRoot === bundleRoot || containsActiveRoot) { continue; }
      if (typeof entry.retiredAt === "number" && Date.now() - entry.retiredAt >= retentionMs) {
        try { fs.rmSync(retiredRoot, { recursive: true, force: true }); } catch { kept.push(entry); }
      } else { kept.push(entry); }
    }
    current.retired = kept;
    const cleanupState = statePath + ".gc-" + process.pid;
    try {
      fs.writeFileSync(cleanupState, JSON.stringify(current) + "\n", { mode: 0o600 });
      fs.renameSync(cleanupState, statePath);
    } catch { try { fs.unlinkSync(cleanupState); } catch {} }
    try {
      const retiredRoots = new Set((Array.isArray(current.retired) ? current.retired : [])
        .map((entry) => entry && typeof entry.root === "string" ? path.resolve(entry.root) : undefined)
        .filter(Boolean));
      for (const name of fs.readdirSync(bundlesRoot)) {
        const candidate = path.join(bundlesRoot, name);
        const stats = fs.statSync(candidate);
        if (!activeRoots.has(candidate) && !retiredRoots.has(candidate) &&
            Date.now() - Math.max(stats.mtimeMs, stats.ctimeMs) >= retentionMs) {
          fs.rmSync(candidate, { recursive: true, force: true });
        }
      }
    } catch {}
    try {
      const claimed = new Set((Array.isArray(current.links) ? current.links : [])
        .map((link) => link && typeof link.backup === "string" ? path.resolve(link.backup) : undefined)
        .filter(Boolean));
      for (const name of fs.readdirSync(backupRoot)) {
        const candidate = path.join(backupRoot, name);
        const stats = fs.statSync(candidate);
        if (!claimed.has(candidate) && Date.now() - Math.max(stats.mtimeMs, stats.ctimeMs) >= retentionMs) {
          fs.rmSync(candidate, { recursive: true, force: true });
        }
      }
    } catch {}
  } catch {}
  process.stdout.write(JSON.stringify({ ok: true, fingerprint: manifest.fingerprint }));
} finally {
  fs.rmSync(lockPath, { recursive: true, force: true });
}
`;
}
