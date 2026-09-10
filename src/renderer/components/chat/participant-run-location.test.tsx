import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ParticipantRunLocation } from "./participant-run-location";
import { ParticipantRuntimeControls } from "./chat-participant-runtime-controls";
import { validateChatCliAgents } from "./chat-cli-readiness";
import type { AppBridge } from "../../../shared/types";

function bridge(prepare?: () => Promise<unknown>) {
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    setTimeout, clearTimeout, consensus: {
      listMachines: async () => ({ machines: [{ id: "cloud", name: "Cloud", awsInstanceId: "i-abc" }], status: [] }),
      onMachinesUpdated: () => () => {}, onCloudRunPreparationProgress: () => () => {},
      prepareCloudRun: prepare ?? (async () => ({ machine: { id: "cloud", name: "Cloud", awsInstanceId: "i-abc" } })),
      listProviderModels: async () => ({ models: [] })
    } as unknown as AppBridge
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { addEventListener() {}, removeEventListener() {} } });
}

test("Cloud selection waits for setup and failed setup leaves the previous machine selected", async () => {
  bridge(async () => { throw new Error("SSH unavailable"); });
  const changes: unknown[] = [];
  let view!: ReactTestRenderer;
  await act(async () => { view = create(<ParticipantRunLocation kind="codex-cli" onChange={patch => changes.push(patch)} />); });
  await act(async () => { view.root.findByType("select").props.onChange({ currentTarget: { value: "cloud" } }); });
  assert.deepEqual(changes, []);
  assert.equal(view.root.findByType("select").props.value, "local");
  assert.match(JSON.stringify(view.toJSON()), /SSH unavailable/);
  bridge();
  await act(async () => { view.root.findByType("select").props.onChange({ currentTarget: { value: "cloud" } }); });
  assert.deepEqual(changes, [{ homeMachineId: "cloud", remoteExecution: "local" }]);
  view.unmount();
});

test("after the first run the selector explains the lock and never starts setup", async () => {
  let calls = 0; bridge(async () => { calls++; return {}; });
  let view!: ReactTestRenderer;
  await act(async () => { view = create(<ParticipantRunLocation kind="codex-cli" homeMachineId="cloud" locked onChange={() => assert.fail("locked")} />); });
  assert.equal(view.root.findByType("select").props.disabled, true);
  await act(async () => { view.root.findByType("select").props.onChange({ currentTarget: { value: "local" } }); });
  assert.match(JSON.stringify(view.toJSON()), /Remove and add the member again/);
  assert.equal(calls, 0);
  view.unmount();
});

test("choosing an already enrolled AWS machine still checks the selected provider", async () => {
  let calls = 0;
  bridge(async () => { calls++; throw new Error("Claude needs sign-in"); });
  const changes: unknown[] = [];
  let view!: ReactTestRenderer;
  await act(async () => { view = create(<ParticipantRunLocation kind="claude-code" onChange={patch => changes.push(patch)} />); });
  await act(async () => { view.root.findByType("select").props.onChange({ currentTarget: { value: "machine:cloud" } }); });
  assert.equal(calls, 1);
  assert.deepEqual(changes, []);
  assert.match(JSON.stringify(view.toJSON()), /Claude needs sign-in/);
  view.unmount();
});

test("editing another runtime setting preserves the locked home machine", async () => {
  bridge(); const changes: any[] = [];
  let view!: ReactTestRenderer;
  await act(async () => { view = create(<TooltipProvider><ParticipantRuntimeControls
    participant={{ id: "member", handle: "member", kind: "codex-cli", roleConfigId: "engineer", homeMachineId: "cloud" }}
    disabled={false} runLocationLocked onUpdate={(_id, patch) => changes.push(patch)} /></TooltipProvider>); });
  act(() => { view.root.findByProps({ "aria-label": "Mode" }).props.onChange({ currentTarget: { value: "auto" } }); });
  assert.equal(changes[0].homeMachineId, "cloud");
  assert.equal(changes[0].agentMode, "auto");
  view.unmount();
});

test("a machine member is not blocked by a missing local CLI", () => {
  assert.equal(validateChatCliAgents([{ kind: "claude-code", homeMachineId: "cloud" }], []), undefined);
  assert.ok(validateChatCliAgents([{ kind: "claude-code" }], []));
});
