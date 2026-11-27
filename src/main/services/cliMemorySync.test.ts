import assert from "node:assert/strict";
import test from "node:test";
import { MEMORY_BODY_MAX_BYTES } from "../../shared/memory";
import { lineHoldsSecret, withoutSecretLines } from "../../shared/secretPatterns";
import { noteBody, noteTitle, splitFrontMatter } from "./cliMemorySync/entryText";
import { ProjectFolders, projectsOfChats, projectsOfMachine } from "./cliMemorySync/projects";
import { claudeIndexTitles, claudeMemoryEntry, codexSummaryEntry, codexTaskGroups } from "./cliMemorySync/stores";

test("Claude Code memory files read in both front matter formats, titled by the index", () => {
  const index = "- [Reply in Russian](reply-in-russian.md) — she writes Russian\n* [Cloud Runs feature](./cloud-runs.md) — branch\n- [Elsewhere](../x.md)\n";
  const titles = claudeIndexTitles(index);
  assert.equal(titles.get("reply-in-russian.md"), "Reply in Russian");
  assert.equal(titles.get("cloud-runs.md"), "Cloud Runs feature");
  assert.equal(titles.has("../x.md"), false);

  // The newer format: a slug name and the type under metadata.
  const newer = "---\nname: reply-in-russian\ndescription: \"The User writes in Russian; reply in Russian.\"\nmetadata:\n  node_type: memory\n  type: feedback\n  modified: 2026-11-21T21:38:56.571Z\n---\n\nAnswer briefly.\n";
  const reply = claudeMemoryEntry("reply-in-russian.md", newer, titles.get("reply-in-russian.md"));
  assert.deepEqual(reply, { kind: "article", title: "Reply in Russian", body: "The User writes in Russian; reply in Russian.\n\nAnswer briefly.", tags: ["preference"] });

  // The older format: a name written for people, the type at the top; no index line.
  const older = "---\nname: Answer questions with words, not code changes\ndescription: CRITICAL — answer first.\ntype: feedback\n---\nWhen the user asks a question, explain.\n";
  assert.equal(claudeMemoryEntry("feedback_answer.md", older, undefined)?.title, "Answer questions with words, not code changes");

  // A project memory about where work stands is a status; a decision is an article.
  const status = claudeMemoryEntry("cloud.md", "---\nname: cloud\ndescription: remote runs; branch feature/cloud-runs, merged to beta\ntype: project\n---\nBody.", undefined);
  assert.equal(status?.kind, "status");
  assert.deepEqual(status?.tags, []);
  const decision = claudeMemoryEntry("parity.md", "---\nname: parity\ndescription: two hard requirements and the exceptions register\ntype: project\n---\nBody.", undefined);
  assert.equal(decision?.kind, "article");
  assert.equal(claudeMemoryEntry("ref.md", "---\ntype: reference\n---\nhttps://example.test/dashboard", undefined)?.kind, "article");
  // Without a title anywhere: the file's name, readable.
  assert.equal(claudeMemoryEntry("ref_dash-board.md", "---\ntype: reference\n---\nsee", undefined)?.title, "ref dash board");
  // Nothing in it: no entry.
  assert.equal(claudeMemoryEntry("empty.md", "---\nname: empty\ntype: user\n---\n\n", undefined), undefined);
});

test("front matter: quotes, Windows line ends, a top-level key over a nested one", () => {
  const read = splitFrontMatter("﻿---\r\nname: 'It''s'\r\ntype: user\r\nmetadata:\r\n  type: feedback\r\n---\r\nText\r\n");
  assert.deepEqual(read.fields, { name: "It's", type: "user" });
  assert.equal(read.content, "Text\n");
  assert.deepEqual(splitFrontMatter("no front matter").fields, {});
});

test("Codex memories: one entry per task group with the folder it applies to, and the summary without its index", () => {
  const handbook = [
    "# Task Group: AccordAgents phone QA",
    "",
    "scope: phone QA",
    "applies_to: cwd=/work/accord/.worktrees/phone; reuse_rule=same repo",
    "## Task 1: run it",
    "# Task Group: AccordAgents phone QA",
    "scope: again",
    "# Task Group: Russian answers",
    "scope: chat",
    "applies_to: cwd=/private/tmp/chat-1"
  ].join("\n");
  const groups = codexTaskGroups(handbook);
  assert.deepEqual(groups.map((group) => [group.name, group.cwd ?? null, group.kind]), [
    ["MEMORY.md#AccordAgents phone QA", "/work/accord/.worktrees/phone", "runbook"],
    ["MEMORY.md#AccordAgents phone QA (2)", null, "runbook"],
    ["MEMORY.md#Russian answers", "/private/tmp/chat-1", "runbook"]
  ]);
  assert.match(groups[0].body, /^# Task Group: AccordAgents phone QA\n\nscope: phone QA/);

  const summary = codexSummaryEntry("v1\n\n## User Profile\n\nPrecise.\n\n## What's in Memory\n\n### /tmp/x\n- stuff\n\n## General Tips\n\nBe brief.\n");
  assert.equal(summary?.kind, "article");
  assert.deepEqual(summary?.tags, ["preference"]);
  assert.equal(summary?.body, "## User Profile\n\nPrecise.\n\n## General Tips\n\nBe brief.");
  assert.equal(codexSummaryEntry("v1\n"), undefined);
});

test("lines that look like secrets are left out; ordinary words about keys stay", () => {
  assert.equal(lineHoldsSecret("OPENAI_API_KEY=sk-proj-abcdefghijklmnop1234"), true);
  assert.equal(lineHoldsSecret("password: hunter2"), true);
  assert.equal(lineHoldsSecret("token = 0123456789abcdef0123456789abcdef"), true);
  assert.equal(lineHoldsSecret("Authorization: Bearer abc.def-123"), true);
  assert.equal(lineHoldsSecret("aws AKIAABCDEFGHIJKLMNOP"), true);
  assert.equal(lineHoldsSecret("ghp_abcdefghijklmnopqrstuvwxyz"), true);
  assert.equal(lineHoldsSecret("The key is entered in Settings; the token goes to her server."), false);
  assert.equal(lineHoldsSecret("Token: the per-run one"), false);
  assert.equal(lineHoldsSecret("merged to beta 6dc75a5e, id 9a164578-838b-4b14-b945-07a110366ce0"), false);
  const text = "keep\napi_key: AIzaSyA-1234567890abcdefghijklmnopqrstu\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA\n-----END OPENSSH PRIVATE KEY-----\nalso keep";
  assert.deepEqual(withoutSecretLines(text), { text: "keep\nalso keep", dropped: 4 });
});

test("a note's title and body stay under the note's limits", () => {
  assert.equal([...noteTitle("x".repeat(400))].length, 160);
  const { body, dropped } = noteBody(`${"строка памяти\n".repeat(3000)}secret: abcdefgh12345678`, "~/.claude/projects/p/memory/big.md");
  assert.equal(dropped, 1);
  assert.ok(Buffer.byteLength(body) <= MEMORY_BODY_MAX_BYTES);
  assert.match(body, /…\(cut here; the whole entry is ~\/\.claude\/projects\/p\/memory\/big\.md on its device\)$/);
  // One huge line: cut inside it, never inside a character.
  const huge = noteBody("я".repeat(20_000), "f.md").body;
  assert.ok(Buffer.byteLength(huge) <= MEMORY_BODY_MAX_BYTES);
  assert.ok(!huge.includes("�"));
});

test("Claude folders map to the User's projects, a worktree's to its repository's", async () => {
  const roots: Record<string, string> = { "/work/accord/.worktrees/x": "/work/accord", "/work/tool": "/work/tool" };
  let asked = 0;
  const folders = new ProjectFolders(async (dir) => { asked += 1; return roots[dir]; });
  const projects = projectsOfChats([
    { kind: "chat", repoPath: "/work/accord/.worktrees/x" },
    { kind: "chat", repoPath: "/work/tool/" },
    { kind: "chat", repoPath: "/work/tool/" },
    { kind: "code-review", repoPath: "/work/legacy" },
    { kind: "chat" }
  ]);
  assert.deepEqual(projects, [
    { projectPath: "/work/accord/.worktrees/x", localPath: "/work/accord/.worktrees/x" },
    { projectPath: "/work/tool/", localPath: "/work/tool" }
  ]);
  const map = await folders.claudeFolders(projects);
  assert.equal(map.get("-work-accord--worktrees-x"), "/work/accord/.worktrees/x");
  assert.equal(map.get("-work-accord"), "/work/accord/.worktrees/x");
  assert.equal(map.get("-work-tool"), "/work/tool/");
  await folders.claudeFolders(projects);
  assert.equal(asked, 2, "a repository's folder is remembered");
  assert.equal(folders.projectFor(projects, "/work/accord/.worktrees/x/src"), "/work/accord/.worktrees/x");
  assert.equal(folders.projectFor(projects, "/work/toolbox"), undefined);

  // A cloud machine: the copies the computer published, and chats without one.
  assert.deepEqual(projectsOfMachine({ "/work/accord": "/home/u/copies/accord" }, [
    { kind: "chat", repoPath: "/home/u/copies/accord" },
    { kind: "chat", repoPath: "/work/same-folder" }
  ]), [
    { projectPath: "/work/accord", localPath: "/home/u/copies/accord" },
    { projectPath: "/work/same-folder", localPath: "/work/same-folder" }
  ]);
});
