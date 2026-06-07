import assert from "node:assert/strict";
import test from "node:test";
import { normalizeExternalUrlForOpen } from "../../shared/externalLinks";

test("normalizeExternalUrlForOpen accepts http and https URLs", () => {
  assert.equal(normalizeExternalUrlForOpen("https://example.com"), "https://example.com/");
  assert.equal(normalizeExternalUrlForOpen("http://example.com/path?q=1"), "http://example.com/path?q=1");
});

test("normalizeExternalUrlForOpen rejects unsafe or malformed URLs", () => {
  assert.throws(() => normalizeExternalUrlForOpen("javascript:alert(1)"), /protocol is not allowed/);
  assert.throws(() => normalizeExternalUrlForOpen("file:///tmp/example.txt"), /protocol is not allowed/);
  assert.throws(() => normalizeExternalUrlForOpen("not a url"), /invalid/);
  assert.throws(() => normalizeExternalUrlForOpen(42), /must be a string/);
});
