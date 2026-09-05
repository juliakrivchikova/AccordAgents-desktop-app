import assert from "node:assert/strict";
import test from "node:test";
import {
  HybridLogicalClock,
  compareLogicalOrder,
  formatHlcKey,
  isLegacyLogicalTs,
  logicalOrderKey,
  parseHlcKey
} from "../../shared/hlc";

test("formatHlcKey/parseHlcKey round-trip with fixed-width digits", () => {
  const key = formatHlcKey({ wallMs: 1_700_000_000_123, counter: 7, originId: "device-a" });
  assert.equal(key, "hlc:1700000000123:000007:device-a");
  assert.deepEqual(parseHlcKey(key), { wallMs: 1_700_000_000_123, counter: 7, originId: "device-a" });
  assert.equal(parseHlcKey("0000000000000001:device-a:scope"), undefined);
});

test("tick advances monotonically even when the wall clock goes backwards", () => {
  let now = 1_000;
  const clock = new HybridLogicalClock("device-a", () => now);
  const first = clock.tick();
  now = 900;
  const second = clock.tick();
  const third = clock.tick();
  assert.ok(first < second && second < third);
  assert.deepEqual(parseHlcKey(second), { wallMs: 1_000, counter: 1, originId: "device-a" });
  assert.deepEqual(parseHlcKey(third), { wallMs: 1_000, counter: 2, originId: "device-a" });
});

test("observe moves the clock past every received event", () => {
  let now = 1_000;
  const local = new HybridLogicalClock("device-a", () => now);
  const remote = new HybridLogicalClock("device-b", () => 5_000);
  const remoteKey = remote.tick();
  local.observe({ logicalTs: remoteKey, originId: "device-b", originSeq: 1 });
  const next = local.tick();
  assert.ok(next > remoteKey, `${next} must sort after ${remoteKey}`);
  assert.equal(parseHlcKey(next)?.wallMs, 5_000);
  now = 6_000;
  assert.equal(parseHlcKey(local.tick())?.wallMs, 6_000);
});

test("legacy logicalTs maps to a derived key from createdAt and originSeq", () => {
  const legacy = {
    logicalTs: "0000000000000042:device-legacy:scope",
    originId: "device-legacy",
    originSeq: 42,
    createdAt: "2026-08-06T00:00:01.000Z"
  };
  assert.equal(isLegacyLogicalTs(legacy.logicalTs), true);
  assert.equal(logicalOrderKey(legacy), formatHlcKey({ wallMs: Date.parse(legacy.createdAt), counter: 42, originId: "device-legacy" }));
  const hlcLater = { logicalTs: formatHlcKey({ wallMs: Date.parse(legacy.createdAt) + 1, counter: 0, originId: "device-new" }), originId: "device-new", originSeq: 1 };
  const hlcEarlier = { logicalTs: formatHlcKey({ wallMs: Date.parse(legacy.createdAt) - 1, counter: 99, originId: "device-new" }), originId: "device-new", originSeq: 1 };
  assert.equal(compareLogicalOrder(legacy, hlcLater), -1);
  assert.equal(compareLogicalOrder(hlcEarlier, legacy), -1);
});

test("unknown logicalTs formats fall back to raw string order", () => {
  const a = { logicalTs: "0001", originId: "x", originSeq: 1 };
  const b = { logicalTs: "0002", originId: "x", originSeq: 2 };
  assert.equal(compareLogicalOrder(a, b), -1);
  assert.equal(compareLogicalOrder(b, a), 1);
  assert.equal(compareLogicalOrder(a, a), 0);
});

test("restore never moves the clock backwards", () => {
  const clock = new HybridLogicalClock("device-a", () => 10);
  clock.restore({ wallMs: 500, counter: 3 });
  assert.deepEqual(clock.current(), { wallMs: 500, counter: 3, originId: "device-a" });
  clock.restore({ wallMs: 100, counter: 9 });
  assert.deepEqual(clock.current(), { wallMs: 500, counter: 3, originId: "device-a" });
  assert.deepEqual(parseHlcKey(clock.tick()), { wallMs: 500, counter: 4, originId: "device-a" });
});

test("compareLogicalTsValues keeps same-family string order and puts the HLC era after legacy values", () => {
  const { compareLogicalTsValues } = require("../../shared/hlc") as typeof import("../../shared/hlc");
  assert.equal(compareLogicalTsValues("0000000000000002:device:scope", "0000000000000003:device:scope"), -1);
  assert.equal(compareLogicalTsValues("0000000000000003:device:scope", "0000000000000002:device:scope"), 1);
  assert.equal(compareLogicalTsValues("hlc:0000000000001:000000:a", "hlc:0000000000001:000001:a"), -1);
  assert.equal(compareLogicalTsValues("hlc:0000000000001:000000:a", "0000000000000099:device:scope"), 1);
  assert.equal(compareLogicalTsValues("0000000000000099:device:scope", "hlc:0000000000001:000000:a"), -1);
  assert.equal(compareLogicalTsValues("x", "x"), 0);
});
