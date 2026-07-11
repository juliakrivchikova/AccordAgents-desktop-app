import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizePluginIconSpacers,
  replaceActivePluginMention,
  replaceActiveSlashQuery,
  stripPluginIconMetadata
} from "./chat-composer-plugin-token";

test("plugin mentions keep composer alignment metadata out of sent messages", () => {
  const draft = replaceActivePluginMention("Please /bui", "build-web-apps");

  assert.equal(stripPluginIconMetadata(draft), "Please /build-web-apps ");
  assert.notEqual(draft, stripPluginIconMetadata(draft));
});

test("reselecting a plugin consumes the existing spacer without leaking Unicode", () => {
  const selected = replaceActivePluginMention("/bui", "build-web-apps").trimEnd();
  const reselected = replaceActivePluginMention(selected, "build-web-apps");

  assert.equal(stripPluginIconMetadata(reselected), "/build-web-apps ");
});

test("replacing a selected plugin with another slash result consumes the spacer", () => {
  const selected = replaceActivePluginMention("/bui", "build-web-apps").trimEnd();
  const replaced = replaceActiveSlashQuery(selected, "/compact ");

  assert.equal(stripPluginIconMetadata(replaced), "/compact ");
});

test("editing a selected plugin removes its obsolete alignment spacer", () => {
  const selected = replaceActivePluginMention("/bui", "build-web-apps");
  const edited = selected.replace("build-web-apps", "build-web-app");

  assert.equal(normalizePluginIconSpacers(edited, ["build-web-apps"]), "/build-web-app ");
});
