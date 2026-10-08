import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const generalSettings = read("src/renderer/components/settings/general-settings-section.tsx");
const awsPage = read("src/renderer/components/settings/aws-settings-page.tsx");
const awsSetup = read("src/renderer/components/settings/aws-setup-section.tsx");
const awsStatus = read("src/renderer/components/settings/aws-status-section.tsx");
const awsStatusLabel = read("src/renderer/components/settings/use-aws-worker-status.ts");
const awsDialogParts = read("src/renderer/components/settings/aws-dialog.tsx");
const awsShared = read("src/renderer/components/settings/aws-shared.tsx");
const copyButton = read("src/renderer/components/primitives/copy-button.tsx");
const awsFiles = ["aws-settings-page", "aws-status-section", "aws-program-section", "aws-instance-section", "aws-disk-section",
  "aws-disk-browser", "aws-setup-section", "aws-connect-section", "aws-dialog", "aws-sign-in-dialog", "aws-worker-auto-stop", "aws-shared"]
  .map((name) => read(`src/renderer/components/settings/${name}.tsx`));
const environmentSettings = read("src/renderer/components/settings/environment-settings-section.tsx");
const toggleCss = read("src/renderer/styles/views/content-markdown.css");
const approvalCss = read("src/renderer/styles/views/chat-conversation.css");
const providerAuthCss = read("src/renderer/styles/views/provider-device-auth.css");
const appCss = read("src/renderer/styles/app.css");
const codexDeviceAuth = read("src/renderer/components/codex-device-auth.tsx");
const iconButtonCss = read("src/renderer/styles/views/icon-button.css");

test("the machine instance page offers nothing the deleted worker used to need", () => {
  // The per-turn worker is gone, and with it the toggle that switched it on,
  // the SSH target and paths it ran through, its timeouts, and the doctor that
  // checked them. What is left is the instance a machine is installed onto,
  // on its own Settings page.
  assert.match(awsPage, /data-testid="machine-instance-settings"/);
  assert.doesNotMatch(generalSettings, /machine-instance-settings|AwsWorkerPanel|AwsSettingsPage/);
  for (const source of [generalSettings, ...awsFiles]) {
    assert.doesNotMatch(source, /data-testid="remote-codex-worker-toggle"/);
    assert.doesNotMatch(source, /Worker source/);
    assert.doesNotMatch(source, /placeholder="Worker root"/);
    assert.doesNotMatch(source, /placeholder="Codex path"/);
    assert.doesNotMatch(source, /Cloud Runs \(beta\)/);
  }
  // Checking and preparing the instance are retained by the resolution and
  // must stay reachable; the page checks by itself and fixes from each row.
  assert.match(awsSetup, /diagnoseCloudRunWorker\(undefined\)/);
  assert.match(awsSetup, /setupCloudRunWorker\(undefined\)/);
});

test("every copy control is the shared icon with a guarded exact-payload clipboard write", () => {
  assert.equal(copyButton.match(/writeClipboardText\(/g)?.length, 1);
  assert.match(copyButton, /writeClipboardText\(props\.text,/);
  assert.match(copyButton, /"Copy failed"/);
  assert.match(awsDialogParts, /<CopyButton /);
  for (const source of [generalSettings, ...awsFiles]) {
    assert.doesNotMatch(source, /await navigator\.clipboard\.writeText/);
    assert.doesNotMatch(source, /className="gen-aws-copy"/);
  }
});

test("AWS page exposes one-click progress, actual specs, choices, and shared cost warning", () => {
  assert.match(awsStatus, /data-testid="aws-worker-start"/);
  assert.match(awsShared, /Starting/);
  assert.match(awsShared, /Waiting for running/);
  assert.match(awsShared, /Setting up/);
  assert.match(awsStatus, /data-testid="aws-worker-actual-specs"/);
  assert.match(awsStatus, /Keep current size/);
  assert.match(awsStatus, /Grow disk/);
  assert.match(awsStatus, /Recreate/);
  assert.match(awsStatusLabel, /Running · billable/);
  for (const source of awsFiles) assert.doesNotMatch(source, />Set up</);
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
  assert.match(appCss, /@import "\.\/views\/provider-device-auth\.css"/);
  // The copy control is the shared icon button: an explicit label, and the
  // shared keyboard focus ring.
  assert.match(codexDeviceAuth, /className="provider-device-auth-copy" label="Copy sign-in code"/);
  assert.match(
    iconButtonCss,
    /button\.aa-icon-button:focus-visible\s*\{[^}]*box-shadow:\s*var\(--focus-ring\)/s
  );
  assert.match(appCss, /@import "\.\/views\/icon-button\.css"/);
  assert.match(environmentSettings, /aria-label=\{`Enable \$\{variable\.key\}`\}/);
});
