import assert from "node:assert/strict";
import test from "node:test";
import {
  BETA_UPDATE_REPO,
  STABLE_UPDATE_REPO,
  resolveUpdateRepo
} from "./appUpdater";

test("resolveUpdateRepo returns the stable repo unless beta updates are enabled", () => {
  assert.equal(resolveUpdateRepo(false), STABLE_UPDATE_REPO);
  assert.equal(resolveUpdateRepo(true), BETA_UPDATE_REPO);
});
