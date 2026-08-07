import assert from "node:assert/strict";
import test from "node:test";
import {
  assertHostProviderCanStopWhenIdle,
  hostProviderIdlePolicy,
  type HostProviderCapability
} from "../../shared/hostProviderCapabilities";

test("hostProviderIdlePolicy allows stopWhenIdle only with wake path or always-on no-op", () => {
  assert.deepEqual(hostProviderIdlePolicy(provider({
    supportsWakePath: true,
    supportsStopWhenIdle: true,
    minimumPostWakeUptimeMs: 120_000
  })), {
    status: "allowed",
    reason: "wake-path"
  });
  assert.deepEqual(hostProviderIdlePolicy(provider({
    alwaysOn: true,
    supportsStopWhenIdle: true
  })), {
    status: "allowed",
    reason: "always-on-noop"
  });
  assert.deepEqual(hostProviderIdlePolicy(provider({
    supportsStopWhenIdle: false
  })), {
    status: "allowed",
    reason: "always-on-noop"
  });
});

test("assertHostProviderCanStopWhenIdle denies stopWhenIdle without phone-reachable wake", () => {
  assert.throws(
    () => assertHostProviderCanStopWhenIdle(provider({ supportsStopWhenIdle: true })),
    /cannot stopWhenIdle without a phone-reachable wake path/
  );
});

test("host provider wake path requires minimum post-wake uptime floor", () => {
  assert.throws(
    () => hostProviderIdlePolicy(provider({ supportsWakePath: true, supportsStopWhenIdle: true })),
    /wake path requires minimumPostWakeUptimeMs/
  );
});

function provider(overrides: Partial<HostProviderCapability>): HostProviderCapability {
  return {
    providerId: "provider-1",
    kind: "byo-host",
    supportsWakePath: false,
    alwaysOn: false,
    supportsStopWhenIdle: false,
    ...overrides
  };
}
