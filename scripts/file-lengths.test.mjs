import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { longFiles, MAX_LINES } from "./check-file-lengths.mjs";

test(`no source file is longer than ${MAX_LINES} lines`, () => {
  assert.deepEqual(longFiles(path.resolve(import.meta.dirname, "..")), []);
});
