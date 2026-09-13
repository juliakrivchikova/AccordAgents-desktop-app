import assert from "node:assert/strict";
import test from "node:test";
import type { AwsWorkerStartRequest } from "../../../shared/types";
import { OLD_ERROR, RUNNING, SETTINGS, change, click, ready, renderPanel, textOf, unmount } from "./aws-worker-panel-harness.test";

test("a healthy running instance offers Stop only; a stopped one offers Start only", async () => {
  const running = await renderPanel({ status: RUNNING });
  assert.equal(running.root.findAllByProps({ "data-testid": "aws-worker-start" }).length, 0);
  assert.equal(running.root.findAllByProps({ "data-testid": "aws-worker-stop" }).length, 1);
  assert.match(textOf(running.root.findByProps({ "data-testid": "aws-worker-billing-note" })), /does not stop by itself/);
  assert.match(textOf(running.root.findByProps({ "data-testid": "aws-cloud-run-readiness" })), /select it in a member/);
  unmount(running);
  const stopped = await renderPanel({ status: { ...RUNNING, state: "stopped" } });
  assert.equal(textOf(stopped.root.findByProps({ "data-testid": "aws-worker-start" })), "Start instance");
  assert.equal(stopped.root.findAllByProps({ "data-testid": "aws-worker-stop" }).length, 0);
  assert.equal(stopped.root.findAllByProps({ "data-testid": "aws-worker-billing-note" }).length, 0);
  assert.match(textOf(stopped.root.findByProps({ "data-testid": "aws-cloud-run-readiness" })), /Start the instance to use Cloud run/);
  assert.equal(textOf(stopped.root).includes("unavailable while the instance is stopped"), false);
  unmount(stopped);
});

test("a current permission failure shows one retry and its recovery, never two retries", async () => {
  const renderer = await renderPanel({ status: { ...RUNNING, state: "stopped" }, start: async request => {
    const operation = { ...OLD_ERROR, operationId: request.operationId, updatedAt: new Date().toISOString() };
    return { operation, status: { ...RUNNING, state: "stopped", operation } };
  } });
  await click(renderer.root.findByProps({ "data-testid": "aws-worker-start" }));
  const retries = renderer.root.findAll(node => node.type === "button" && /try again|retry/i.test(textOf(node)));
  assert.equal(retries.length, 1);
  assert.equal(textOf(retries[0]), "Try again");
  assert.equal(renderer.root.findAllByProps({ "data-testid": "aws-worker-history" }).length, 0, "the attempt shown live is not also history");
  await click(renderer.root.findByProps({ "data-testid": "aws-worker-authorization-toggle" }));
  assert.match(textOf(renderer.root.findByProps({ "data-testid": "aws-worker-authorization-steps" })), /Apply update and try again/);
  unmount(renderer);
});

test("a completed previous attempt is not shown as history", async () => {
  const renderer = await renderPanel({ status: { ...RUNNING, operation: ready({ operationId: "done" }).operation } });
  assert.equal(renderer.root.findAllByProps({ "data-testid": "aws-worker-history" }).length, 0);
  unmount(renderer);
});

test("a first connection keeps its action beside the pasted result and offers nothing else", async () => {
  const requests: AwsWorkerStartRequest[] = [];
  const renderer = await renderPanel({ status: { configured: false }, settings: { ...SETTINGS, hasAwsCredentials: false }, start: async request => { requests.push(request); return ready(request); } });
  assert.equal(renderer.root.findAllByProps({ "data-testid": "aws-worker-start" }).length, 0);
  assert.equal(renderer.root.findAllByProps({ "data-testid": "aws-worker-stop" }).length, 0);
  assert.equal(renderer.root.findAll(node => node.type === "button" && textOf(node) === "Refresh status").length, 0);
  assert.equal(renderer.root.findByProps({ "data-testid": "aws-worker-connect-start" }).props.disabled, true);
  await change(renderer.root.findByProps({ "aria-label": "AWS setup result" }), "accord-aws-v1:new");
  await click(renderer.root.findByProps({ "data-testid": "aws-worker-connect-start" }));
  assert.equal(requests[0].blob, "accord-aws-v1:new");
  assert.equal(requests[0].intent, "setup");
  unmount(renderer);
});
