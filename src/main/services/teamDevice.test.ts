import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BUILD_INFO_FILE,
  TEAM_DEVICE_ENV,
  TEAM_DEVICE_MARKER,
  moveTeamDeviceSessions,
  officialReleaseVersion,
  readBuiltFromReleaseTag,
  readTeamDevice,
  teamDeviceForcedOn,
  teamDeviceFrom
} from "./teamDevice";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "accord-team-device-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function stamp(appPath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(path.join(appPath, BUILD_INFO_FILE)), { recursive: true });
  await writeFile(path.join(appPath, BUILD_INFO_FILE), contents);
}

test("only release numbers count as releases", () => {
  for (const version of ["1.11.8", "1.11.9-beta.1", "2.0.0-beta.12"]) {
    assert.equal(officialReleaseVersion(version), true, version);
  }
  for (const version of ["1.11.8-discussion.1", "1.11.8-rc.1", "1.11.9-beta", "1.11.9-beta.1-local", "1.11.8+mac", "dev", ""]) {
    assert.equal(officialReleaseVersion(version), false, version);
  }
});

test("a packaged release from its tag on an unmarked computer is a real installation", () => {
  const release = { isPackaged: true, version: "1.11.9-beta.1", fromReleaseTag: true, marked: false, forcedOn: false };
  assert.equal(teamDeviceFrom(release), false);
  // A stamp that is missing or unreadable counts as a release.
  assert.equal(teamDeviceFrom({ ...release, fromReleaseTag: undefined }), false);
  // Each sign of our own on its own is enough.
  assert.equal(teamDeviceFrom({ ...release, isPackaged: false }), true, "not packaged");
  assert.equal(teamDeviceFrom({ ...release, version: "1.11.8-discussion.1" }), true, "not a release number");
  assert.equal(teamDeviceFrom({ ...release, fromReleaseTag: false }), true, "not built from its release tag");
  assert.equal(teamDeviceFrom({ ...release, marked: true }), true, "marked by the file");
  assert.equal(teamDeviceFrom({ ...release, forcedOn: true }), true, "marked by the environment");
});

test("the environment marks a computer only with an explicit yes", () => {
  for (const value of ["1", "true", "TRUE", " on ", "yes"]) {
    assert.equal(teamDeviceForcedOn({ [TEAM_DEVICE_ENV]: value }), true, value);
  }
  for (const value of [undefined, "", "0", "false", "off", "no", "team"]) {
    assert.equal(teamDeviceForcedOn({ [TEAM_DEVICE_ENV]: value }), false, String(value));
  }
});

test("the build stamp: true, false, or unknown", async () => {
  await withTempDir(async (appPath) => {
    assert.equal(readBuiltFromReleaseTag(appPath), undefined, "no stamp");
    await stamp(appPath, "{not json");
    assert.equal(readBuiltFromReleaseTag(appPath), undefined, "unreadable");
    await stamp(appPath, "{}\n");
    assert.equal(readBuiltFromReleaseTag(appPath), undefined, "git could not tell");
    await stamp(appPath, JSON.stringify({ fromReleaseTag: "yes" }));
    assert.equal(readBuiltFromReleaseTag(appPath), undefined, "not a boolean");
    await stamp(appPath, JSON.stringify({ fromReleaseTag: false }));
    assert.equal(readBuiltFromReleaseTag(appPath), false);
    await stamp(appPath, JSON.stringify({ fromReleaseTag: true }));
    assert.equal(readBuiltFromReleaseTag(appPath), true);
  });
});

test("a launch reads the marker file, the environment and the build together", async () => {
  await withTempDir(async (dir) => {
    const userDataDir = path.join(dir, "profile");
    const appPath = path.join(dir, "app");
    await mkdir(userDataDir, { recursive: true });
    await stamp(appPath, JSON.stringify({ fromReleaseTag: true }));
    const release = { userDataDir, appPath, isPackaged: true, version: "1.11.9", env: {} };
    assert.equal(readTeamDevice(release), false);
    assert.equal(readTeamDevice({ ...release, env: { [TEAM_DEVICE_ENV]: "1" } }), true);
    assert.equal(readTeamDevice({ ...release, isPackaged: false }), true);
    await writeFile(path.join(userDataDir, TEAM_DEVICE_MARKER), "");
    assert.equal(readTeamDevice(release), true, "an empty marker file is enough");
    await rm(path.join(userDataDir, TEAM_DEVICE_MARKER));
    await stamp(appPath, JSON.stringify({ fromReleaseTag: false }));
    assert.equal(readTeamDevice(release), true, "a packaged build of an untagged commit");
    // A profile that is not there yet (first launch) is not a marker.
    assert.equal(readTeamDevice({ ...release, userDataDir: path.join(dir, "missing"), appPath: path.join(dir, "no-app") }), false);
    // A marker in the computer's usual profile marks a profile named with
    // ACCORDAGENTS_USER_DATA_DIR too.
    const usual = path.join(dir, "usual");
    await mkdir(usual, { recursive: true });
    await stamp(appPath, JSON.stringify({ fromReleaseTag: true }));
    assert.equal(readTeamDevice({ ...release, defaultUserDataDir: usual }), false);
    await writeFile(path.join(usual, TEAM_DEVICE_MARKER), "");
    assert.equal(readTeamDevice({ ...release, defaultUserDataDir: usual }), true);
  });
});

test("a team device's sessions leave the release channels; nothing else moves", () => {
  const session = (environment: string) => ({ sid: "s", status: "ok", attrs: { release: "AccordAgents@1.11.9+mac", environment } });
  const production = session("production");
  const beta = session("beta");
  const laterChannel = session("rc");
  const development = session("development");
  const aggregate = { aggregates: [{ started: "2026-11-19T18:00:00Z", exited: 1 }], attrs: { release: "AccordAgents@1.11.9+mac", environment: "production" } };
  const error = { event_id: "e", environment: "beta", tags: { team_device: true } };
  const log = { items: [{ body: "first_chat", attributes: { "sentry.environment": { value: "beta", type: "string" } } }] };
  moveTeamDeviceSessions([
    [{ type: "session" }, production],
    [{ type: "session" }, beta],
    [{ type: "session" }, laterChannel],
    [{ type: "session" }, development],
    [{ type: "sessions" }, aggregate],
    [{ type: "event" }, error],
    [{ type: "log" }, log],
    [{ type: "session" }, { sid: "no-attrs" }],
    [undefined, undefined]
  ]);
  assert.equal(production.attrs.environment, "team");
  assert.equal(beta.attrs.environment, "team");
  assert.equal(laterChannel.attrs.environment, "team", "a channel added later is left too");
  assert.equal(development.attrs.environment, "development", "a build that is not packaged keeps its own environment");
  assert.equal(aggregate.attrs.environment, "team");
  assert.equal(error.environment, "beta", "error reports keep their environment");
  assert.equal(log.items[0].attributes["sentry.environment"].value, "beta", "signals keep their environment");
  assert.equal(production.attrs.release, "AccordAgents@1.11.9+mac", "only the environment changes");
});
