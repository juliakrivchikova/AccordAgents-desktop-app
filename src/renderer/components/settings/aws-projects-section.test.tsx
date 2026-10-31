import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { mount, unmount } from "./aws-settings-page-harness.test";

// Settings → AWS → Projects: the one place where project copies on the
// instance are added and deleted.

test("projects on the instance are listed, deleted after asking with their members' work, and added from this computer's projects", async () => {
  const ui = await mount();
  const rows = [...document.querySelectorAll('[data-testid="aws-project"]')];
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent ?? "", /AccordAgents · 1\.5 GB/);
  assert.match(rows[0].textContent ?? "", /~\/IdeaProjects\/AccordAgents · holds members' work: member's worktree · uncommitted changes/);
  assert.match(rows[1].textContent ?? "", /in use right now/);
  assert.ok(rows[1].querySelector<HTMLButtonElement>('[data-testid="aws-project-delete"]')?.disabled, "a copy in use cannot be deleted");
  assert.match(ui.find("aws-projects")?.textContent ?? "", /2 of 4 projects/);

  await ui.click(rows[0].querySelector('[data-testid="aws-project-delete"]'));
  const dialog = ui.find("aws-project-delete-dialog");
  assert.match(dialog?.textContent ?? "", /Delete AccordAgents\?/);
  assert.match(dialog?.textContent ?? "", /holds members' work that is only there \(member's worktree · uncommitted changes\), which is deleted with it/);
  assert.match(dialog?.textContent ?? "", /next message to a cloud member in it copies it again/);
  assert.equal(ui.bridge.calls.deleteAwsInstanceFiles?.length ?? 0, 0, "nothing before the confirmation");
  await ui.click(ui.find("aws-project-delete-dialog-confirm"));
  assert.deepEqual(ui.bridge.calls.deleteAwsInstanceFiles, [[["/home/ubuntu/own/workspace/mirrors/AccordAgents-0a6205133d"],
    { withWork: { "/home/ubuntu/own/workspace/mirrors/AccordAgents-0a6205133d": ["worktree", "changes"] } }]], "the work she was shown goes with it");
  assert.equal(ui.find("aws-project-delete-dialog"), null);
  assert.ok((ui.bridge.calls.listAwsInstanceProjects?.length ?? 0) >= 2, "listed again after the delete");

  let finish!: () => void;
  const copied = new Promise<void>((resolve) => { finish = resolve; });
  const adding = await mount({ add: () => copied });
  await adding.click(adding.find("aws-project-add"));
  const list = adding.find("aws-project-add-list");
  assert.equal(list?.getAttribute("role"), "radiogroup");
  assert.deepEqual([...(list?.querySelectorAll("[data-path]") ?? [])].map((row) => row.getAttribute("data-path")), ["/Users/me/IdeaProjects/landing", "/Users/me/notes"]);
  assert.match(adding.find("aws-project-add-dialog")?.textContent ?? "", /3\.7 GB free on the instance/);
  await adding.click(list?.querySelector('input[aria-label="notes, ~/notes"]') ?? null);
  assert.equal(adding.find("aws-project-add-confirm")?.textContent, "Copy notes");
  await adding.click(adding.find("aws-project-add-confirm"));
  assert.deepEqual(adding.bridge.calls.addAwsInstanceProject, [["/Users/me/notes"]]);
  await act(async () => { for (const listener of adding.bridge.projectProgress) listener({ localPath: "/Users/me/notes", message: "Copying your project to the cloud · 42%" }); });
  await adding.settle();
  assert.match(adding.find("aws-project-add-dialog")?.textContent ?? "", /Copying your project to the cloud · 42%/);
  assert.ok(adding.find<HTMLButtonElement>("aws-project-add-confirm")?.disabled);
  await act(async () => { finish(); });
  await adding.settle();
  assert.equal(adding.find("aws-project-add-dialog"), null, "closed once the copy is there");
  assert.deepEqual(adding.bridge.calls.getAwsInstanceDisk?.at(-1), [{ refresh: true }], "the disk is measured again");
  await unmount();
});

test("Cancel during a copy stops it and closes without an error; a delete the instance refuses says why and stays open", async () => {
  let fail!: (error: Error) => void;
  const ui = await mount({ add: () => new Promise<void>((_resolve, reject) => { fail = reject; }),
    del: async (paths) => ({ freedBytes: 0, removed: 0, failed: [{ path: paths[0], reason: "in-use" }], space: { totalBytes: 1, usedBytes: 1, availableBytes: 0 } }) });
  await ui.click(ui.find("aws-project-add"));
  await ui.click(ui.find("aws-project-add-confirm"));
  const listed = ui.bridge.calls.listAwsInstanceProjects?.length ?? 0;
  await ui.click(ui.find("aws-project-add-cancel"));
  assert.deepEqual(ui.bridge.calls.cancelAwsInstanceProjectAdd, [["/Users/me/IdeaProjects/landing"]], "Cancel while copying stops the copy");
  await act(async () => { fail(new Error("The copy was cancelled.")); });
  await ui.settle();
  assert.equal(ui.find("aws-project-add-dialog"), null, "closed, as Cancel does elsewhere");
  assert.equal(ui.find("aws-project-add-error"), null);
  assert.ok((ui.bridge.calls.listAwsInstanceProjects?.length ?? 0) > listed, "listed again: what the copy left shows");

  const row = document.querySelector('[data-testid="aws-project"]');
  assert.equal(row?.querySelector("button")?.getAttribute("aria-label"), "Delete AccordAgents from the instance");
  await ui.click(row?.querySelector('[data-testid="aws-project-delete"]') ?? null);
  await ui.click(ui.find("aws-project-delete-dialog-confirm"));
  assert.match(ui.find("aws-project-delete-dialog")?.textContent ?? "", /1 item stayed: in use right now\./);
  await unmount();
});

test("project copies are added and deleted only in Projects: Disk shows their size and All files cannot delete them", async () => {
  const workspace = "/home/ubuntu/own/workspace";
  const ui = await mount({ list: async (path?: string) => path === workspace
    ? { path: workspace, home: "/home/ubuntu", own: "/home/ubuntu/own", truncated: 0, entries: [
      { name: "mirrors", path: `${workspace}/mirrors`, bytes: 1_460_000_000, dir: true, lock: "program", role: "project-copies" }] }
    : path === `${workspace}/mirrors`
      ? { path: `${workspace}/mirrors`, home: "/home/ubuntu", own: "/home/ubuntu/own", truncated: 0, entries: [
        { name: "AccordAgents-0a6205133d", path: `${workspace}/mirrors/AccordAgents-0a6205133d`, bytes: 1_460_000_000, dir: true, lock: null, work: ["changes"] }] }
      : { path: "/home/ubuntu", home: "/home/ubuntu", own: "/home/ubuntu/own", truncated: 0, entries: [
        { name: "workspace", path: workspace, bytes: 1_460_000_000, dir: true, lock: "program", role: "project-copies" },
        { name: "notes.txt", path: "/home/ubuntu/notes.txt", bytes: 10_000, dir: false, lock: null }] } });
  const row = ui.find("aws-disk-project-copies");
  assert.equal(row?.querySelector("button"), null, "no action on the Disk row");
  assert.match(row?.textContent ?? "", /Added and deleted in Projects above\./);
  await ui.click(ui.find("aws-disk-browse-all"));
  await ui.click(document.querySelector('[aria-label="Expand workspace"]'));
  await ui.click(document.querySelector('[aria-label="Expand mirrors"]'));
  const copy = document.querySelector('[data-path$="AccordAgents-0a6205133d"]');
  assert.ok(copy?.classList.contains("is-locked"));
  assert.match(copy?.textContent ?? "", /added and deleted in Projects above/);
  assert.equal(copy?.querySelector(".gen-aws-tree-work"), null, "no work mark where it cannot be chosen");
  assert.ok(copy?.querySelector<HTMLInputElement>("input")?.disabled);
  assert.ok(!document.querySelector<HTMLInputElement>('input[aria-label="Select notes.txt"]')?.disabled, "other files are deleted as before");
  await unmount();
});
