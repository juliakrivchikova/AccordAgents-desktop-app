import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { MachineRuntimePayloadSource } from "../../../shared/machineInstall";
import type { MachineBundle } from "./types";

/** Where the runtime payload the desktop would install came from. It decides
 *  what a failure means: a checkout can rebuild, an installed application
 *  cannot. */
export type MachineBundleSource = MachineRuntimePayloadSource;

export interface ReadMachineBundleOptions {
  source?: MachineBundleSource;
  /** The desktop's own version. A payload built for a different version would
   *  put a runtime on the machine that this desktop was never built against. */
  expectVersion?: string;
}

const PAYLOAD_MANIFEST = "payload.json";

interface PayloadManifest {
  manifestVersion: number;
  version: string;
  generatedAt?: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
}

/**
 * Reads and verifies the runtime payload this desktop would install.
 *
 * A packaged application ships this inside its own resources and cannot
 * rebuild it, so every file is checked against the manifest the build wrote:
 * exact set, exact size, exact hash. A payload truncated by a partial download
 * or a half-finished copy is refused here rather than installed on a machine
 * as a runtime that cannot start. The bundle digest — which names the release
 * directory on the machine — is computed from the same pass.
 */
export function readMachineBundle(bundleDir: string, options: ReadMachineBundleOptions = {}): MachineBundle {
  const dir = path.resolve(bundleDir);
  const source = options.source ?? "checkout";
  const rebuild = rebuildHint(source, dir);
  if (!fs.existsSync(path.join(dir, "accordagents-machine.cjs"))) {
    throw new Error(`The machine runtime payload is missing from ${dir}. ${rebuild}`);
  }
  if (!fs.existsSync(path.join(dir, "nativeProcessSupervisor.cjs"))) {
    // Without the supervisor the runtime cannot own or verifiably close a
    // provider process, which silently breaks Stop on that machine.
    throw new Error(`The machine runtime payload in ${dir} has no nativeProcessSupervisor.cjs. ${rebuild}`);
  }
  let version: string;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { version?: unknown };
    if (typeof pkg.version !== "string" || !pkg.version.trim()) throw new Error("no version");
    version = pkg.version.trim();
  } catch {
    throw new Error(`The machine runtime payload in ${dir} has no readable package.json. ${rebuild}`);
  }

  const scan = scanBundle(dir, rebuild);
  const manifest = readPayloadManifest(dir, rebuild);
  verifyPayload(manifest, scan.files, dir, rebuild);
  if (manifest.version !== version) {
    throw new Error(
      `The machine runtime payload in ${dir} is inconsistent: its manifest says ${manifest.version} and its package.json says ${version}. ${rebuild}`
    );
  }
  if (options.expectVersion && options.expectVersion !== version) {
    throw new Error(
      `This desktop is ${options.expectVersion} but its machine runtime payload is ${version}. `
      + `Installing it would put a runtime on the machine that this desktop was not built against. ${rebuild}`
    );
  }
  return {
    dir,
    version,
    digest: scan.digest,
    files: scan.files.length,
    bytes: scan.files.reduce((total, file) => total + file.bytes, 0)
  };
}

function rebuildHint(source: MachineBundleSource, dir: string): string {
  if (source === "packaged") {
    return "This copy of AccordAgents is incomplete; reinstall it from the release you downloaded.";
  }
  if (source === "override") {
    return `ACCORDAGENTS_MACHINE_BUNDLE_DIR points at ${dir}; build a bundle there with \`npm run build:machine\`.`;
  }
  return "Build it with `npm run build:machine` first.";
}

function readPayloadManifest(dir: string, rebuild: string): PayloadManifest {
  const manifestPath = path.join(dir, PAYLOAD_MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`The machine runtime payload in ${dir} has no ${PAYLOAD_MANIFEST}. ${rebuild}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    throw new Error(`The machine runtime payload manifest in ${dir} could not be read. ${rebuild}`);
  }
  const manifest = parsed as Partial<PayloadManifest>;
  if (!manifest || manifest.manifestVersion !== 1 || typeof manifest.version !== "string" || !Array.isArray(manifest.files)) {
    throw new Error(`The machine runtime payload manifest in ${dir} is not one this version understands. ${rebuild}`);
  }
  for (const file of manifest.files) {
    if (!file || typeof file.path !== "string" || typeof file.bytes !== "number" || typeof file.sha256 !== "string") {
      throw new Error(`The machine runtime payload manifest in ${dir} is damaged. ${rebuild}`);
    }
  }
  return manifest as PayloadManifest;
}

function verifyPayload(
  manifest: PayloadManifest,
  found: readonly BundleFile[],
  dir: string,
  rebuild: string
): void {
  const byPath = new Map(found.map((file) => [file.path, file]));
  for (const expected of manifest.files) {
    const actual = byPath.get(expected.path);
    if (!actual) {
      throw new Error(`The machine runtime payload in ${dir} is missing ${expected.path}. ${rebuild}`);
    }
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
      throw new Error(`The machine runtime payload in ${dir} is damaged: ${expected.path} does not match the build. ${rebuild}`);
    }
    byPath.delete(expected.path);
  }
  const extra = [...byPath.keys()].sort();
  if (extra.length) {
    throw new Error(`The machine runtime payload in ${dir} has files the build did not produce (${extra.slice(0, 3).join(", ")}). ${rebuild}`);
  }
}

interface BundleFile {
  path: string;
  bytes: number;
  sha256: string;
}

/** One pass over the payload: per-file hashes for the manifest check and the
 *  tree digest that names the release directory on the machine. `node_modules`
 *  (installed on the machine) and the manifest itself are excluded, so adding
 *  the manifest did not change how existing releases are identified. Anything
 *  that is not a regular file or a directory is refused, not skipped. */
function scanBundle(dir: string, rebuild: string): { files: BundleFile[]; digest: string } {
  const hash = createHash("sha256");
  const files: BundleFile[] = [];
  const walk = (current: string, prefix: string): void => {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .filter((entry) => entry.name !== "node_modules" && !(prefix === "" && entry.name === PAYLOAD_MANIFEST))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        hash.update(`d:${relative}\0`);
        walk(full, relative);
      } else if (entry.isFile()) {
        const contents = fs.readFileSync(full);
        const digest = createHash("sha256").update(contents).digest();
        hash.update(`f:${relative}\0`);
        hash.update(digest);
        files.push({ path: relative, bytes: contents.byteLength, sha256: digest.toString("hex") });
      } else {
        // Anything else is refused rather than skipped. `rsync -a` copies a
        // symbolic link to the machine as a link, so a payload that merely
        // ignored one would put content there that the manifest never
        // described and the digest never covered — verified on a real machine:
        // a link named appSkills/escape.md arrived and resolved to /etc/hosts.
        throw new Error(
          `The machine runtime payload in ${dir} contains ${relative}, which is ${describeEntry(entry)}. `
          + "A payload may only contain regular files and directories, because anything else is copied to the "
          + `machine without being covered by the manifest. ${rebuild}`
        );
      }
    }
  };
  walk(dir, "");
  return { files, digest: hash.digest("hex") };
}

function describeEntry(entry: fs.Dirent): string {
  if (entry.isSymbolicLink()) return "a symbolic link";
  if (entry.isFIFO()) return "a named pipe";
  if (entry.isSocket()) return "a socket";
  if (entry.isBlockDevice() || entry.isCharacterDevice()) return "a device file";
  return "not a regular file";
}
