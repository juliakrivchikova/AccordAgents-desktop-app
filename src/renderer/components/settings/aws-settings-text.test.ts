import assert from "node:assert/strict";
import test from "node:test";

import { updateFailureText } from "./aws-program-section";
import { setupItems } from "./aws-setup-section";
import { formatBytes, keptText } from "./use-aws-disk";

test("a failed update reads as one sentence with its cause", () => {
  assert.equal(updateFailureText("1.11.2-beta.3", "the machine's disk is full"), "The update to 1.11.2-beta.3 failed: the machine's disk is full.");
  assert.equal(updateFailureText("1.11.2-beta.3", "Runtime update failed: ssh exited with code 1: npm ERR! network."),
    "The update to 1.11.2-beta.3 failed: ssh exited with code 1: npm ERR! network.");
  assert.equal(updateFailureText(undefined, undefined), "The last update failed.");
  // A cause that starts with an acronym keeps its capitals.
  assert.equal(updateFailureText("1.2.0", "SSH connection failed"), "The update to 1.2.0 failed: SSH connection failed.");
  assert.equal(updateFailureText("1.2.0", "AWS did not return an address"), "The update to 1.2.0 failed: AWS did not return an address.");
  assert.equal(updateFailureText("1.2.0", "Npm could not reach the registry"), "The update to 1.2.0 failed: npm could not reach the registry.");
});

test("sizes read the way Finder shows them", () => {
  assert.equal(formatBytes(2_260_000_000), "2.3 GB");
  assert.equal(formatBytes(900_000_000), "900 MB");
  assert.equal(formatBytes(4_000), "4 KB");
  // A value that rounds up to the next unit is said in that unit.
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(999), "999 B");
  assert.equal(formatBytes(999_600), "1 MB");
  assert.equal(formatBytes(999_400), "999 KB");
  assert.equal(formatBytes(999_600_000), "1.0 GB");
  assert.equal(formatBytes(999_400_000), "999 MB");
  assert.equal(formatBytes(1e9), "1.0 GB");
});

test("what a change kept is said by its reason, and an error is not called in use", () => {
  assert.equal(keptText([]), undefined);
  assert.equal(keptText([{ path: "/a", reason: "error", message: "Permission denied" }]), "1 item could not be removed: Permission denied.");
  assert.equal(keptText([{ path: "/a", reason: "in-use" }, { path: "/b", reason: "unpushed" }, { path: "/c", reason: "in-use" }]),
    "3 items stayed: in use right now; has commits not pushed anywhere.");
});

test("setup rows speak in product words; a provider's install and sign-in are one row", () => {
  const items = setupItems([
    { id: "connect", label: "SSH connection", status: "pass" },
    { id: "codex", label: "Codex CLI", status: "pass" },
    { id: "codex-auth", label: "Codex signed in", status: "fail", fixable: true },
    { id: "claude", label: "Claude Code CLI", status: "warn", fixable: true },
    { id: "claude-auth", label: "Claude Code signed in", status: "warn", fixable: true },
    { id: "gh", label: "GitHub CLI", status: "fail", fixable: true },
    { id: "sudo", label: "Passwordless sudo", status: "pass" },
    { id: "userns", label: "Unprivileged user namespaces", status: "fail", fixable: true }
  ] as never);
  const byKey = Object.fromEntries(items.map((item) => [item.key, item]));
  assert.equal(byKey["codex-auth"].label, "Codex");
  assert.equal(byKey["codex-auth"].fix, "sign-in");
  assert.equal(byKey["codex-auth"].provider, "codex-cli");
  assert.equal(byKey["codex-auth"].required, true);
  // Claude is not used here: not installed is said, but it is not a failure.
  assert.equal(byKey.claude.required, false);
  assert.equal(byKey.claude.fix, "install");
  assert.equal(byKey["claude-auth"], undefined, "one row per provider");
  assert.equal(byKey.gh.label, "GitHub CLI");
  assert.match(byKey.gh.detail, /cannot open pull requests/);
  assert.equal(byKey.userns.label, "Codex sandbox");
  assert.equal(byKey.userns.fix, "fix");
  assert.equal(byKey.sudo.label, "Administrator rights");
  assert.equal(byKey.connect.ok, true);
});
