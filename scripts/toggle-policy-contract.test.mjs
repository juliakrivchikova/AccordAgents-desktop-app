import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const generalSettings = read("src/renderer/components/settings/general-settings-section.tsx");
const awsWorkerPanel = read("src/renderer/components/settings/aws-worker-panel.tsx");
const environmentSettings = read("src/renderer/components/settings/environment-settings-section.tsx");
const toggleCss = read("src/renderer/styles/views/content-markdown.css");
const approvalCss = read("src/renderer/styles/views/chat-conversation.css");
const generalCss = read("src/renderer/styles/views/settings-general.css");

test("the machine instance panel offers nothing the deleted worker used to need", () => {
  // The per-turn worker is gone, and with it the toggle that switched it on,
  // the SSH target and paths it ran through, its timeouts, and the doctor that
  // checked them. What is left is the instance a machine is installed onto.
  assert.match(generalSettings, /data-testid="machine-instance-settings"/);
  assert.doesNotMatch(generalSettings, /data-testid="remote-codex-worker-toggle"/);
  assert.doesNotMatch(generalSettings, /Worker source/);
  assert.doesNotMatch(generalSettings, /placeholder="Worker root"/);
  assert.doesNotMatch(generalSettings, /placeholder="Codex path"/);
  // Checking and preparing the instance are retained by the resolution and
  // must stay reachable; what they may not offer is a hand-written worker.
  assert.match(generalSettings, /diagnoseCloudRunWorker\(undefined\)/);
  assert.match(generalSettings, /setupCloudRunWorker\(undefined\)/);
  assert.match(generalSettings, /data-testid="machine-instance-check"/);
  assert.match(generalSettings, /data-testid="machine-instance-setup"/);
  assert.doesNotMatch(generalSettings, /Cloud Runs \(beta\)/);
});

test("the surviving worker copy button uses a guarded exact-payload clipboard write", () => {
  // The general settings copy button belonged to the deleted worker's device
  // sign-in. The instance panel's remains, and its guarantee is unchanged.
  assert.equal(generalSettings.match(/writeClipboardText\(/g)?.length, undefined);
  assert.equal(awsWorkerPanel.match(/writeClipboardText\(/g)?.length, 1);
  assert.match(awsWorkerPanel, /writeClipboardText\(command,/);
  assert.equal(awsWorkerPanel.match(/\? "Copy failed"/g)?.length, 1);
  assert.doesNotMatch(generalSettings, /await navigator\.clipboard\.writeText/);
  assert.doesNotMatch(awsWorkerPanel, /await navigator\.clipboard\.writeText/);
});

test("AWS worker panel exposes one-click progress, actual specs, choices, and shared cost warning", () => {
  assert.match(awsWorkerPanel, /data-testid="aws-worker-start"/);
  assert.match(awsWorkerPanel, /Starting/);
  assert.match(awsWorkerPanel, /Waiting for running/);
  assert.match(awsWorkerPanel, /Setting up/);
  assert.match(awsWorkerPanel, /data-testid="aws-worker-actual-specs"/);
  assert.match(awsWorkerPanel, /Keep using/);
  assert.match(awsWorkerPanel, /Grow disk/);
  assert.match(awsWorkerPanel, /Recreate/);
  assert.match(awsWorkerPanel, /Running · billable/);
  assert.doesNotMatch(awsWorkerPanel, />Set up</);
});

test("generic toggles distinguish usable-off and disabled-checked states", () => {
  assert.match(toggleCss, /\.toggle input:not\(:checked\):not\(:disabled\) \+ span\s*\{/);
  assert.match(toggleCss, /\.toggle input:checked:disabled \+ span\s*\{/);
});

test("approval toggles derive disabled visuals from the native input and fieldset", () => {
  assert.match(
    approvalCss,
    /\.chat-app-tool-review-toggle input:not\(:checked\):not\(:disabled\) \+ \.chat-app-tool-review-switch/
  );
  assert.match(
    approvalCss,
    /\.chat-app-tool-review-fieldset:disabled \.chat-app-tool-review-toggle/
  );
});

test("copy focus and manual toggle accessibility contracts remain explicit", () => {
  assert.match(
    generalCss,
    /\.gen-doctor-auth-copy:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--app-accent\)/s
  );
  assert.match(environmentSettings, /aria-label=\{`Enable \$\{variable\.key\}`\}/);
});
