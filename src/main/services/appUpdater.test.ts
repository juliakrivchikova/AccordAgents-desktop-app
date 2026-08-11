import assert from "node:assert/strict";
import test from "node:test";
import {
  BETA_UPDATE_REPO,
  STABLE_UPDATE_REPO,
  resolveUpdateRepo,
  supportsAutoUpdates
} from "./appUpdater";

test("resolveUpdateRepo returns the stable repo unless beta updates are enabled", () => {
  assert.equal(resolveUpdateRepo(false), STABLE_UPDATE_REPO);
  assert.equal(resolveUpdateRepo(true), BETA_UPDATE_REPO);
});

test("supports the packaged macOS and Squirrel.Windows update paths only", () => {
  assert.equal(supportsAutoUpdates(true, "darwin"), true);
  assert.equal(supportsAutoUpdates(true, "win32"), true);
  assert.equal(supportsAutoUpdates(true, "linux"), false);
  assert.equal(supportsAutoUpdates(false, "darwin"), false);
  assert.equal(supportsAutoUpdates(false, "win32"), false);
});
