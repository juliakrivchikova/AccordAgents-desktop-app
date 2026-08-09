import assert from "node:assert/strict";
import test from "node:test";
import { create, type ReactTestRenderer } from "react-test-renderer";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { ChatParticipant } from "../../../shared/types";
import { ChatActiveRunRow } from "./chat-active-run-popover";

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    clearTimeout: globalThis.clearTimeout,
    setTimeout: globalThis.setTimeout
  }
});
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: {
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  }
});

const PARTICIPANTS: ChatParticipant[] = [
  {
    id: "participant-1",
    handle: "alpha",
    roleConfigId: "software-engineer",
    kind: "codex-cli"
  },
  {
    id: "participant-2",
    handle: "beta",
    roleConfigId: "software-engineer",
    kind: "claude-code"
  }
];

test("active-run rows navigate to the clicked participant", () => {
  const selectedParticipantIds: string[] = [];
  const renderer = renderRows(PARTICIPANTS.map((participant) => (
    <ChatActiveRunRow
      key={participant.id}
      participant={participant}
      runIds={[`run-${participant.id}`]}
      status="running"
      renderParticipantAvatar={() => <span>avatar</span>}
      participantRoleLabel={() => "Software Engineer"}
      onSelectParticipant={(participantId) => selectedParticipantIds.push(participantId)}
    />
  )));

  const identities = renderer.root.findAllByProps({ className: "composer-active-run-row-main" });
  assert.equal(identities.length, 2);
  identities[1].props.onClick();

  assert.deepEqual(selectedParticipantIds, ["participant-2"]);
  renderer.unmount();
});

test("active-run stop is isolated from participant navigation", () => {
  const selectedParticipantIds: string[] = [];
  const stoppedRunIds: string[][] = [];
  const renderer = renderRows((
    <ChatActiveRunRow
      participant={PARTICIPANTS[0]}
      runIds={["run-1", "run-2"]}
      status="running"
      renderParticipantAvatar={() => <span>avatar</span>}
      participantRoleLabel={() => "Software Engineer"}
      onSelectParticipant={(participantId) => selectedParticipantIds.push(participantId)}
      onStopParticipantRuns={(runIds) => stoppedRunIds.push(runIds)}
    />
  ));

  const identity = renderer.root.findByProps({ className: "composer-active-run-row-main" });
  const stop = renderer.root.findByProps({ className: "composer-active-run-row-stop" });
  stop.props.onClick({ defaultPrevented: false });

  assert.deepEqual(stoppedRunIds, [["run-1", "run-2"]]);
  assert.deepEqual(selectedParticipantIds, []);
  assert.equal(identity.findAllByProps({ className: "composer-active-run-row-stop" }).length, 0);
  renderer.unmount();
});

function renderRows(rows: React.ReactNode): ReactTestRenderer {
  return create(<TooltipProvider>{rows}</TooltipProvider>);
}
