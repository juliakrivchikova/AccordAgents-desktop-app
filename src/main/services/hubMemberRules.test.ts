import assert from "node:assert/strict";
import test from "node:test";
import type { HubMemberRules } from "../../shared/hubProtocol";
import type { ChatParticipantConfig, ChatRoleConfig } from "../../shared/types";
import type { HubClient } from "./hubClient";
import { HubMemberRulesPublisher, memberRulesFrom } from "./hubMemberRules";

test("her roles and saved members, as the server holds machines to them", () => {
  const rules = memberRulesFrom({
    chatRoleConfigs: [
      { id: "lead", participantDefaults: { manageRolesParticipants: "allow", requestParticipants: "allow" } },
      { id: "plain" }
    ] as unknown as ChatRoleConfig[],
    chatParticipantConfigs: [
      { id: "preset-qa", handle: "qa", roleConfigId: "plain", homeMachineId: "machine-1", agentMode: "plan", permissions: { workspaceWrite: true }, model: "m" }
    ] as unknown as ChatParticipantConfig[]
  });
  assert.deepEqual(rules, {
    version: 1,
    roles: { lead: { manageRolesParticipants: "allow", requestParticipants: "allow" }, plain: { manageRolesParticipants: "deny" } },
    presets: { "preset-qa": { handle: "qa", roleConfigId: "plain", homeMachineId: "machine-1", agentMode: "plan", permissions: { workspaceWrite: true } } }
  });
});

test("published whatever else is paired, once per change, and again until the server has them", async () => {
  const sent: HubMemberRules[] = [];
  let fail = true;
  const client = { setMemberRules: async (rules: HubMemberRules) => {
    if (fail) throw new Error("The hub answered 404.");
    sent.push(rules);
    return { ok: true };
  } } as unknown as HubClient;
  let rules: HubMemberRules = { version: 1, roles: {}, presets: {} };
  const logged: string[] = [];
  const publisher = new HubMemberRulesPublisher({ client: () => client, rules: async () => rules, log: (event) => { logged.push(event); } });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  publisher.publish();
  await settle();
  assert.deepEqual(logged, ["hub.member-rules.error"], "a server that does not take them yet is tried again later");
  fail = false;
  publisher.publish();
  await settle();
  publisher.publish();
  await settle();
  assert.equal(sent.length, 1, "unchanged rules are not sent again");
  rules = { version: 1, roles: { lead: { manageRolesParticipants: "allow" } }, presets: {} };
  publisher.publish();
  await settle();
  assert.equal(sent.length, 2);
  publisher.reset();
  publisher.publish();
  await settle();
  assert.equal(sent.length, 3, "another server gets them again");
});
