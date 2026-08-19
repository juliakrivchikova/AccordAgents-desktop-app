import { createHash } from "node:crypto";
import { copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const sqliteVersion = "3.53.4";
const archiveName = "sqlite-tools-win-x64-3530400.zip";
const archiveUrl = `https://www.sqlite.org/2026/${archiveName}`;
const expectedArchiveSha3 = "88b4659fe747896b853af10157316b4ade143553efb89c1c8ca7423a278dcc8b";
const expectedExecutableSha256 = "5da2398d4913b893bd1ea578d85403b3a83a06fabf9d2303ca9f63ef0849fc6f";
const expectedExecutableSize = 4_022_272;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const targetPath = path.join(repoRoot, "assets", "sqlite", "win32-x64", "sqlite3.exe");

function digest(algorithm, data) {
  return createHash(algorithm).update(data).digest("hex");
}

const tempDir = await mkdtemp(path.join(os.tmpdir(), "accordagents-sqlite-"));
try {
  const response = await fetch(archiveUrl);
  if (!response.ok) {
    throw new Error(`SQLite download failed with HTTP ${response.status}.`);
  }

  const archive = Buffer.from(await response.arrayBuffer());
  const archiveSha3 = digest("sha3-256", archive);
  if (archiveSha3 !== expectedArchiveSha3) {
    throw new Error(`Unexpected SQLite archive SHA3-256: ${archiveSha3}`);
  }

  const archivePath = path.join(tempDir, archiveName);
  await writeFile(archivePath, archive);
  const extraction = spawnSync("tar.exe", ["-xf", archivePath, "-C", tempDir], {
    encoding: "utf8"
  });
  if (extraction.status !== 0) {
    throw new Error(`Could not extract SQLite tools: ${extraction.stderr || extraction.stdout}`);
  }

  const extractedPath = path.join(tempDir, "sqlite3.exe");
  const executable = await readFile(extractedPath);
  const executableSha256 = digest("sha256", executable);
  const executableStats = await stat(extractedPath);
  if (executableSha256 !== expectedExecutableSha256 || executableStats.size !== expectedExecutableSize) {
    throw new Error(
      `Unexpected sqlite3.exe identity: SHA-256 ${executableSha256}, size ${executableStats.size}.`
    );
  }

  await mkdir(path.dirname(targetPath), { recursive: true });
  await copyFile(extractedPath, targetPath);

  const version = spawnSync(targetPath, ["-version"], { encoding: "utf8" });
  if (version.status !== 0 || !version.stdout.startsWith(sqliteVersion)) {
    throw new Error(`Bundled sqlite3 version check failed: ${version.stderr || version.stdout}`);
  }
  process.stdout.write(`Updated ${targetPath}\n${version.stdout}`);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
