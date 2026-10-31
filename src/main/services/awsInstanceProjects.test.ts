import assert from "node:assert/strict";
import test from "node:test";
import type { MachineInstallRecord } from "../../shared/machineInstall";
import type { AwsDiskListing, AwsInstanceProjectProgress } from "../../shared/types";
import { AWS_PROJECTS_NOT_SET_UP, AwsInstanceProjectsService } from "./awsInstanceProjects";

const MIRRORS = "/home/ubuntu/accordagents-x/workspace/mirrors";
const RECORD = { machineId: "m1", installRoot: "/home/ubuntu/accordagents-x", installedVersion: "1.0.0",
  projects: {
    "/Users/me/AccordAgents": `${MIRRORS}/AccordAgents-0a6205133d/repo`,
    // Recorded once, deleted on the instance since.
    "/Users/me/gone": `${MIRRORS}/gone-1111111111/repo`
  } } as unknown as MachineInstallRecord;
const LISTING: AwsDiskListing = { path: MIRRORS, home: "/home/ubuntu", own: "/home/ubuntu/accordagents-x", truncated: 0,
  space: { totalBytes: 40e9, usedBytes: 9e9, availableBytes: 31e9 },
  entries: [
    { name: "AccordAgents-0a6205133d", path: `${MIRRORS}/AccordAgents-0a6205133d`, bytes: 2.8e9, dir: true, lock: null, work: ["changes"] },
    { name: "old-thing-2222222222", path: `${MIRRORS}/old-thing-2222222222`, bytes: 5e6, dir: true, lock: "in-use" },
    { name: "stray.txt", path: `${MIRRORS}/stray.txt`, bytes: 10, dir: false, lock: null }
  ] };

function service(overrides: Partial<ConstructorParameters<typeof AwsInstanceProjectsService>[0]> = {}) {
  const progress: AwsInstanceProjectProgress[] = [];
  const copies: Array<{ machineId: string; localPath: string; signal: AbortSignal }> = [];
  const forgotten: Array<[string, string[]]> = [];
  const projects = new AwsInstanceProjectsService({
    record: async () => RECORD,
    listCopies: async () => LISTING,
    knownProjects: async () => [
      { path: "/Users/me/AccordAgents", label: "AccordAgents" },
      { path: "/Users/me/gone", label: "gone" },
      { path: "/Users/me/notes", label: "notes" }
    ],
    copy: async (machineId, localPath, signal, report) => { copies.push({ machineId, localPath, signal }); report("Copying your project to the cloud · 50%"); },
    progress: (item) => { progress.push(item); },
    forget: async (machineId, localPaths) => { forgotten.push([machineId, localPaths]); },
    ...overrides
  });
  return { projects, progress, copies, forgotten };
}

test("the copies on the instance are named after this computer's projects, and what is not there can be added", async () => {
  const { projects, forgotten } = service();
  const result = await projects.list();
  assert.deepEqual(forgotten, [["m1", ["/Users/me/gone"]]], "a recorded copy the instance does not have is forgotten");
  assert.deepEqual(result.copies, [
    { path: `${MIRRORS}/AccordAgents-0a6205133d`, name: "AccordAgents", localPath: "/Users/me/AccordAgents", bytes: 2.8e9, lock: null, work: ["changes"] },
    { path: `${MIRRORS}/old-thing-2222222222`, name: "old-thing", bytes: 5e6, lock: "in-use" }
  ]);
  assert.deepEqual(result.available.map((project) => project.path), ["/Users/me/gone", "/Users/me/notes"],
    "a recorded copy that is gone is offered again");
  assert.equal(result.freeBytes, 31e9);
  assert.equal(result.addUnavailable, undefined);
});

test("adding copies on this computer's machine with progress; without the program nothing is copied", async () => {
  const { projects, progress, copies } = service();
  await projects.add("/Users/me/notes");
  assert.deepEqual(copies.map(({ machineId, localPath }) => [machineId, localPath]), [["m1", "/Users/me/notes"]]);
  assert.deepEqual(progress, [{ localPath: "/Users/me/notes", message: "Copying your project to the cloud · 50%" }]);
  await assert.rejects(projects.add("relative/path"), /Choose a project/);
  await assert.rejects(projects.add("/Users/me/.ssh"), /Choose one of your projects/, "only this computer's projects are copied");
  assert.equal(copies.length, 1);

  const bare = service({ record: async () => undefined });
  assert.equal((await bare.projects.list()).addUnavailable, AWS_PROJECTS_NOT_SET_UP);
  await assert.rejects(bare.projects.add("/Users/me/notes"), new RegExp(AWS_PROJECTS_NOT_SET_UP.replace(/\./g, "\\.")));
  assert.equal(bare.copies.length, 0);
});

test("Cancel stops the copy it names, and the same project is not copied twice at once", async () => {
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  const { projects } = service({
    copy: async (_machineId, _localPath, signal) => {
      started();
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }
  });
  const first = projects.add("/Users/me/notes");
  await running;
  await assert.rejects(projects.add("/Users/me/notes"), /being copied already/);
  projects.cancel("/Users/me/other");
  projects.cancel("/Users/me/notes");
  await assert.rejects(first, /^Error: The copy was cancelled\.$/);

  // A Cancel right after Add, before anything was read, stops it too.
  const quick = service();
  const adding = quick.projects.add("/Users/me/notes");
  quick.projects.cancel("/Users/me/notes");
  await assert.rejects(adding, /The copy was cancelled/);
  assert.equal(quick.copies.length, 0, "nothing was copied");
});

test("a truncated listing forgets nothing", async () => {
  const { projects, forgotten } = service({ listCopies: async () => ({ ...LISTING, truncated: 3 }) });
  await projects.list();
  assert.deepEqual(forgotten, []);
});
