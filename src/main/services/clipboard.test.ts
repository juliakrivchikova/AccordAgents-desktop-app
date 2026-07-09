import assert from "node:assert/strict";
import test from "node:test";

import { writeClipboardText } from "../../shared/clipboard";

test("writeClipboardText forwards the exact displayed value", async () => {
  let received = "";
  const displayedValue = "  ABCD-EFGH\n";

  const result = await writeClipboardText(displayedValue, async (value) => {
    received = value;
  });

  assert.equal(result, "copied");
  assert.equal(received, displayedValue);
});

test("writeClipboardText converts clipboard rejection into a handled failure", async () => {
  const result = await writeClipboardText("ABCD-EFGH", async () => {
    throw new Error("clipboard unavailable");
  });

  assert.equal(result, "failed");
});
