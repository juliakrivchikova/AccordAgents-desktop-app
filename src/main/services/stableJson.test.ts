import assert from "node:assert/strict";
import test from "node:test";
import { stableJson } from "../../shared/stableJson";

test("stableJson canonicalizes object keys and omits undefined object fields", () => {
  assert.equal(
    stableJson({ beta: 2, alpha: 1, skipped: undefined }),
    "{\"alpha\":1,\"beta\":2}"
  );
});

test("stableJson preserves array positions with JSON-compatible undefined handling", () => {
  assert.equal(stableJson(["a", undefined, "b"]), "[\"a\",null,\"b\"]");
});
