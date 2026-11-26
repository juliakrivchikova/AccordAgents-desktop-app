import assert from "node:assert/strict";
import test from "node:test";

import type { CliImportThread } from "../../../shared/types";
import { cliImportProjectSections, cliImportThreadRows } from "./cli-import-groups";

const REPO = "/Users/me/WebstormProjects/ai-consensus";

const thread = (sessionId: string, at: string, fields: Partial<CliImportThread> = {}): CliImportThread => ({
  kind: "claude-code",
  sessionId,
  folder: REPO,
  folderExists: true,
  title: sessionId,
  updatedAt: `2026-11-${at}Z`,
  ...fields
});

test("threads fall into projects by their app's project, newest project first, gone folders last", () => {
  const cases: Array<{ name: string; threads: CliImportThread[]; projects: string[]; gone: string[] }> = [
    {
      name: "a worktree session is listed under its repository",
      threads: [
        thread("root", "20T10:00:00"),
        thread("worktree", "25T10:00:00", { folder: `${REPO}/.claude/worktrees/fix-a1b2`, project: REPO })
      ],
      projects: ["ai-consensus: worktree, root"],
      gone: []
    },
    {
      name: "projects are ordered by their newest thread, not by how many they hold",
      threads: [
        thread("old-1", "01T10:00:00", { folder: "/Users/me/big" }),
        thread("old-2", "02T10:00:00", { folder: "/Users/me/big/" }),
        thread("new", "24T10:00:00", { folder: "/Users/me/small" })
      ],
      projects: ["small: new", "big: old-2, old-1"],
      gone: []
    },
    {
      name: "a project is gone only when no thread's folder is left",
      threads: [
        thread("kept", "20T10:00:00"),
        thread("deleted-worktree", "21T10:00:00", { folder: `${REPO}/.claude/worktrees/x`, project: REPO, folderExists: false }),
        thread("scratch", "22T10:00:00", { folder: "/tmp/scratch-1", folderExists: false })
      ],
      projects: ["ai-consensus: deleted-worktree, kept"],
      gone: ["scratch-1: scratch"]
    }
  ];
  for (const { name, threads, projects, gone } of cases) {
    const sections = cliImportProjectSections(threads);
    const outline = (list: typeof sections.projects): string[] =>
      list.map((project) => `${project.label}: ${project.threads.map((item) => item.sessionId).join(", ")}`);
    assert.deepEqual({ projects: outline(sections.projects), gone: outline(sections.gone) }, { projects, gone }, name);
  }
});

test("a side session is listed right after the thread it was started from, one step in", () => {
  const cases: Array<{ name: string; threads: CliImportThread[]; rows: string[] }> = [
    {
      name: "children follow their parent, newest first, even when newer than everything",
      threads: [
        thread("parent", "20T10:00:00"),
        thread("other", "22T10:00:00"),
        thread("side-old", "21T10:00:00", { parentSessionId: "parent" }),
        thread("side-new", "25T10:00:00", { parentSessionId: "parent" })
      ],
      rows: ["other", "parent", "  side-new", "  side-old"]
    },
    {
      name: "a side session whose parent is not listed stays on top",
      threads: [thread("orphan", "21T10:00:00", { parentSessionId: "filtered-out" }), thread("plain", "20T10:00:00")],
      rows: ["orphan", "plain"]
    },
    {
      name: "a parent of another CLI with the same id is not its parent",
      threads: [thread("same", "20T10:00:00", { kind: "codex-cli" }), thread("child", "21T10:00:00", { parentSessionId: "same" })],
      rows: ["child", "same"]
    },
    {
      name: "threads naming each other as parents are all still listed",
      threads: [thread("a", "21T10:00:00", { parentSessionId: "b" }), thread("b", "20T10:00:00", { parentSessionId: "a" })],
      rows: ["a", "  b"]
    }
  ];
  for (const { name, threads, rows } of cases) {
    const listed = cliImportThreadRows(threads).map((row) => `${row.nested ? "  " : ""}${row.thread.sessionId}`);
    assert.deepEqual(listed, rows, name);
  }
});
