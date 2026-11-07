// Builds the speech-to-text engine (whisper.cpp's local server program) from
// the official source at a pinned release, and puts it in dist/whisper. The
// app ships it as a loose resource and runs it on the User's own Mac; the
// speech model itself is downloaded later, when she turns the feature on.
//
// Only macOS builds it. A checkout that cannot build it (no cmake, offline)
// skips it with a warning, so everyday builds keep working and the app shows
// speech to text as missing from that build; a release build (CI, or
// ACCORDAGENTS_REQUIRE_WHISPER=1) fails instead, so a release never ships
// without it.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WHISPER_REPO = "https://github.com/ggml-org/whisper.cpp.git";
const WHISPER_TAG = "v1.9.5";
const WHISPER_COMMIT = "d1be6fde11ac6e0407606b4e42fe72d34add8037";
const CMAKE_FLAGS = [
  "-DCMAKE_BUILD_TYPE=Release",
  "-DBUILD_SHARED_LIBS=OFF",
  "-DGGML_METAL=ON",
  // The GPU code goes inside the program, so it is one self-contained file.
  "-DGGML_METAL_EMBED_LIBRARY=ON",
  // Built for every Apple Silicon Mac, not only the one that builds it.
  "-DGGML_NATIVE=OFF",
  "-DGGML_BLAS=ON",
  "-DWHISPER_BUILD_TESTS=OFF",
  "-DWHISPER_SDL2=OFF",
  "-DWHISPER_CURL=OFF",
  "-DCMAKE_OSX_ARCHITECTURES=arm64",
  "-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0"
];
// One change to the official server: it can listen on a Unix socket, so
// only her user can reach it (a port on 127.0.0.1 is open to every account
// on the Mac, and to web pages). It also refuses bodies over 64 MB.
const SERVER_PATCH_FROM = `    if (!svr->bind_to_port(sparams.hostname, sparams.port))`;
const SERVER_PATCH_TO = `    // AccordAgents: "--host unix:PATH" listens on a Unix socket at PATH.
    svr->set_payload_max_length(64 * 1024 * 1024);
    if (sparams.hostname.rfind("unix:", 0) == 0) {
        svr->set_address_family(AF_UNIX);
        sparams.hostname = sparams.hostname.substr(5);
    }
    if (!svr->bind_to_port(sparams.hostname, sparams.port))`;
const PATCH_ID = createHash("sha256").update(SERVER_PATCH_TO).digest("hex").slice(0, 12);
const STAMP = `whisper-server ${WHISPER_TAG} ${WHISPER_COMMIT} patch-${PATCH_ID} ${CMAKE_FLAGS.join(" ")}`;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(repoRoot, "dist", "whisper");
// The app keeps this program running while she dictates, with the model
// loaded, so a phrase is recognized without loading the model again.
const ENGINE = "whisper-server";
const outputBinary = path.join(outputDir, ENGINE);
const outputStamp = path.join(outputDir, `${ENGINE}.stamp`);
// Kept outside dist so `make clean` does not cost a two-minute rebuild.
const cacheDir = path.join(repoRoot, "node_modules", ".cache", "accordagents-whisper", WHISPER_TAG);
const cachedBinary = path.join(cacheDir, ENGINE);
const cachedStamp = path.join(cacheDir, `${ENGINE}.stamp`);
const required = process.env.CI === "true" || process.env.ACCORDAGENTS_REQUIRE_WHISPER === "1";

function log(message) {
  console.log(`[build-whisper] ${message}`);
}

// Compiler warnings are not ours to read on every build: the output is shown
// only when a step fails.
function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n").slice(-40).join("\n");
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}\n${output}`);
  }
}

async function readStamp(file) {
  return existsSync(file) ? (await readFile(file, "utf8")).trim() : undefined;
}

function findCmake() {
  const candidates = [
    process.env.CMAKE,
    "cmake",
    "/opt/homebrew/bin/cmake",
    "/usr/local/bin/cmake"
  ].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return undefined;
}

async function install(fromBinary) {
  // Only the engine this build makes ships: an older build's program goes.
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await copyFile(fromBinary, outputBinary);
  await chmod(outputBinary, 0o755);
  await writeFile(outputStamp, `${STAMP}\n`);
}

async function main() {
  if (process.platform !== "darwin") {
    log(`skipped: speech to text is built for macOS only (this is ${process.platform})`);
    return;
  }
  if (existsSync(outputBinary) && await readStamp(outputStamp) === STAMP) {
    log(`up to date (${WHISPER_TAG})`);
    return;
  }
  if (existsSync(cachedBinary) && await readStamp(cachedStamp) === STAMP) {
    await install(cachedBinary);
    log(`copied the cached ${WHISPER_TAG} build`);
    return;
  }
  const cmake = findCmake();
  if (!cmake) {
    const message = "cmake was not found, so speech to text is left out of this build. Install it (brew install cmake, or pip install cmake) and build again.";
    if (required) throw new Error(message);
    console.warn(`[build-whisper] WARNING: ${message}`);
    return;
  }

  const sourceDir = path.join(cacheDir, "source");
  const buildDir = path.join(cacheDir, "cmake-build");
  await rm(cacheDir, { recursive: true, force: true });
  await mkdir(cacheDir, { recursive: true });
  log(`fetching whisper.cpp ${WHISPER_TAG}`);
  run("git", ["-c", "advice.detachedHead=false", "clone", "--quiet", "--depth", "1", "--branch", WHISPER_TAG, WHISPER_REPO, sourceDir]);
  const commit = spawnSync("git", ["-C", sourceDir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  if (commit !== WHISPER_COMMIT) {
    throw new Error(`whisper.cpp ${WHISPER_TAG} is commit ${commit}, expected ${WHISPER_COMMIT}; refusing to build it.`);
  }
  const serverSource = path.join(sourceDir, "examples", "server", "server.cpp");
  const original = await readFile(serverSource, "utf8");
  if (original.split(SERVER_PATCH_FROM).length !== 2) {
    throw new Error("whisper.cpp's server.cpp no longer matches the Unix socket patch; update it.");
  }
  await writeFile(serverSource, original.replace(SERVER_PATCH_FROM, SERVER_PATCH_TO));
  log(`building ${ENGINE} with ${cmake}`);
  run(cmake, ["-S", sourceDir, "-B", buildDir, ...CMAKE_FLAGS]);
  run(cmake, ["--build", buildDir, "--config", "Release", "--target", ENGINE, "-j", String(os.cpus().length)]);
  await copyFile(path.join(buildDir, "bin", ENGINE), cachedBinary);
  await writeFile(cachedStamp, `${STAMP}\n`);
  await rm(sourceDir, { recursive: true, force: true });
  await rm(buildDir, { recursive: true, force: true });
  await install(cachedBinary);
  log(`built whisper.cpp ${WHISPER_TAG} into dist/whisper`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (!required) {
    // Offline, GitHub down, a compiler update: everyday builds go on without
    // speech to text rather than failing.
    console.warn(`[build-whisper] WARNING: speech to text is left out of this build: ${message}`);
    return;
  }
  console.error(`[build-whisper] ${message}`);
  process.exit(1);
});
