import { useState } from "react";
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
      getCloudRunPreparation: async () => undefined,
      prepareCloudRun: prepare ?? (async () => ({ machine: { id: "cloud", name: "Cloud", awsInstanceId: "i-abc" } })),
      listProviderModels: async () => ({ models: [] })
    } as unknown as AppBridge
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { addEventListener() {}, removeEventListener() {} } });
}

test("Cloud saves before setup, remains editable, and closing its control cannot lose the choice", async () => {
  let finish!: (value: unknown) => void;
  bridge(() => new Promise(resolve => { finish = resolve; }));
  const changes: any[] = [];
  function Harness() {
    const [patch, setPatch] = useState<any>({});
    return <ParticipantRunLocation kind="codex-cli" {...patch} onChange={value => { changes.push(value); setPatch(value); }} />;
  }
  let view!: ReactTestRenderer;
  await act(async () => { view = create(<Harness />); });
  await act(async () => { view.root.findByType("select").props.onChange({ currentTarget: { value: "cloud" } }); });
  assert.deepEqual(changes, [{ cloudRun: {}, homeMachineId: undefined, remoteExecution: "local" }]);
  assert.equal(view.root.findByType("select").props.value, "cloud");
  assert.equal(view.root.findByType("select").props.disabled, undefined);
  await act(async () => { view.root.findByType("select").props.onChange({ currentTarget: { value: "local" } }); });
  assert.equal(view.root.findByType("select").props.value, "local");
  await act(async () => { view.unmount(); finish({ machine: { id: "late-cloud" } }); });
  assert.equal(changes.length, 2);
  assert.equal(changes[1].cloudRun, undefined);
});

test("failed background setup never undoes Cloud and its error is visible when the control reopens", async () => {
  bridge(async () => { throw new Error("SSH unavailable"); });
  const changes: any[] = [];
  let view!: ReactTestRenderer;
  await act(async () => { view = create(<ParticipantRunLocation kind="codex-cli" onChange={patch => changes.push(patch)} />); });
  await act(async () => { view.root.findByType("select").props.onChange({ currentTarget: { value: "cloud" } }); });
  assert.deepEqual(changes[0].cloudRun, {});
  view.unmount();
  window.consensus.getCloudRunPreparation = async () => ({ operationId: "one", provider: "codex-cli", phase: "error", message: "SSH unavailable" });
  await act(async () => { view = create(<ParticipantRunLocation kind="codex-cli" cloudRun={{}} onChange={() => {}} />); });
  assert.equal(view.root.findByType("select").props.value, "cloud");
  assert.match(JSON.stringify(view.toJSON()), /SSH unavailable/);
  assert.match(JSON.stringify(view.toJSON()), /Retry Cloud setup/);
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
  assert.deepEqual(changes, [{ homeMachineId: undefined, cloudRun: { instanceId: "i-abc" }, remoteExecution: "local" }]);
  view.unmount();
});

test("editing another runtime setting preserves the locked home machine", async () => {
  bridge(); const changes: any[] = [];
  let view!: ReactTestRenderer;
  await act(async () => { view = create(<TooltipProvider><ParticipantRuntimeControls
    participant={{ id: "member", handle: "member", kind: "codex-cli", roleConfigId: "engineer", homeMachineId: "cloud", cloudRun: {} }}
    disabled={false} runLocationLocked onUpdate={(_id, patch) => changes.push(patch)} /></TooltipProvider>); });
  act(() => { view.root.findByProps({ "aria-label": "Mode" }).props.onChange({ currentTarget: { value: "auto" } }); });
  assert.equal(changes[0].homeMachineId, "cloud");
  assert.deepEqual(changes[0].cloudRun, {});
  assert.equal(changes[0].agentMode, "auto");
  view.unmount();
});

test("a machine member is not blocked by a missing local CLI", () => {
  assert.equal(validateChatCliAgents([{ kind: "claude-code", homeMachineId: "cloud" }], []), undefined);
  assert.equal(validateChatCliAgents([{ kind: "claude-code", cloudRun: {} }], []), undefined);
  assert.ok(validateChatCliAgents([{ kind: "claude-code" }], []));
});


test("failed persistence does not start Cloud setup, successful persistence starts it even after closing", async () => {
  let calls = 0; bridge(async () => { calls++; return {}; });
  for (const saved of [false, true]) {
    let finish!: (saved: boolean) => void;
    let view!: ReactTestRenderer;
    await act(async () => { view = create(<ParticipantRunLocation kind="codex-cli" onChange={() => new Promise<boolean>(resolve => { finish = resolve; })} />); });
    await act(async () => { view.root.findByType("select").props.onChange({ currentTarget: { value: "cloud" } }); });
    assert.equal(calls, 0);
    await act(async () => { view.unmount(); finish(saved); });
    assert.equal(calls, saved ? 1 : 0);
  }
});
