// "Allow for this chat" on a member's permission card covers what Claude
// Code's own "Yes, and don't ask again" covers (2.1.329): a command prefix
// for Bash, the domain for WebFetch, the folder for file edits; never the
// whole of such a tool.
import assert from "node:assert/strict";
import test from "node:test";

import {
  chatToolPermissionCoveredByScopes,
  chatToolPermissionIsScoped,
  chatToolPermissionScope,
  chatToolPermissionScopeOptionLabel,
  commandPrefixes,
  normalizeChatToolPermissionScope
} from "./toolPermissionScope";

const bash = (command: string) => ({ command });

test("a command's prefix is its program, with the subcommand of a program that has them; a compound command has one per command", () => {
  assert.deepEqual(commandPrefixes("mkdir -p /tmp/a && date > /tmp/a/stamp.txt && cat /tmp/a/stamp.txt"), ["mkdir", "date", "cat"]);
  assert.deepEqual(commandPrefixes("git commit -m 'fix: a; b'"), ["git commit"]);
  assert.deepEqual(commandPrefixes("npm run test -- --watch"), ["npm run test"]);
  assert.deepEqual(commandPrefixes("FOO=1 ls -la | grep x"), ["ls", "grep"]);
  assert.deepEqual(commandPrefixes("git status; git status"), ["git status"], "each prefix once");
  // A command that runs another command: the whole command, never `sudo`.
  assert.deepEqual(commandPrefixes("sudo rm -rf /tmp/x"), ["sudo rm -rf /tmp/x"]);
  assert.deepEqual(commandPrefixes("bash -c 'echo hi'"), ["bash -c echo hi"]);
  // What decides its command only when it runs: not scoped.
  for (const opaque of ["echo $(whoami)", "echo `id`", "cat <<EOF\nx\nEOF", "(cd /tmp && ls)", "$CMD --flag", "echo 'open", "ls\u00a0-la", "ls\u000b; rm -rf /"]) {
    assert.equal(commandPrefixes(opaque), undefined, opaque);
  }
});

test("the card's option says what Claude Code says", () => {
  assert.equal(chatToolPermissionScopeOptionLabel({ kind: "commands", prefixes: ["mkdir", "date", "cat"] }),
    "Yes, and don't ask again for mkdir, date and cat commands in this chat");
  assert.equal(chatToolPermissionScopeOptionLabel({ kind: "commands", prefixes: ["git commit"] }),
    "Yes, and don't ask again for git commit commands in this chat");
  assert.equal(chatToolPermissionScopeOptionLabel({ kind: "domain", domain: "example.com" }),
    "Yes, and don't ask again for example.com in this chat");
});

test("a saved prefix covers later commands that start with it, every command of a compound one, and never a file written by redirection", () => {
  const scopes = [chatToolPermissionScope("Bash", bash("mkdir -p /tmp/a"))!, chatToolPermissionScope("Bash", bash("git status"))!];
  assert.deepEqual(scopes[0], { kind: "commands", prefixes: ["mkdir"] });
  assert.equal(chatToolPermissionCoveredByScopes("Bash", bash("mkdir -p /tmp/b/c"), scopes), true);
  assert.equal(chatToolPermissionCoveredByScopes("Bash", bash("mkdir /x && git status --short"), scopes), true);
  assert.equal(chatToolPermissionCoveredByScopes("Bash", bash("rm -rf /tmp/a"), scopes), false, "another command asks");
  assert.equal(chatToolPermissionCoveredByScopes("Bash", bash("mkdir /x && rm -rf /"), scopes), false, "every command must be covered");
  assert.equal(chatToolPermissionCoveredByScopes("Bash", bash("mkdirx /x"), scopes), false, "a prefix is a whole word");
  assert.equal(chatToolPermissionCoveredByScopes("Bash", bash("git push"), scopes), false, "git status is not git");
  assert.equal(chatToolPermissionCoveredByScopes("Bash", bash("mkdir $(rm -rf /)"), scopes), false);
  const date = [chatToolPermissionScope("Bash", bash("date"))!];
  assert.equal(chatToolPermissionCoveredByScopes("Bash", bash("date > /etc/hosts"), date), false, "writing a file is asked again");
  assert.equal(chatToolPermissionCoveredByScopes("Bash", bash("date 2>/dev/null"), date), true);
  assert.equal(chatToolPermissionCoveredByScopes("Bash", bash("date 2>&1"), date), true);
});

test("WebFetch is scoped to the domain, file edits to the folder: the working folder for a file in it, else the file's own", () => {
  const domain = chatToolPermissionScope("WebFetch", { url: "https://Docs.Example.com/a?b=1" })!;
  assert.deepEqual(domain, { kind: "domain", domain: "docs.example.com" });
  assert.equal(chatToolPermissionCoveredByScopes("WebFetch", { url: "https://docs.example.com/other" }, [domain]), true);
  assert.equal(chatToolPermissionCoveredByScopes("WebFetch", { url: "https://example.com/" }, [domain]), false);
  assert.equal(chatToolPermissionCoveredByScopes("WebFetch", { url: "https://docs.example.com.evil.io/" }, [domain]), false);

  const inside = chatToolPermissionScope("Write", { file_path: "/work/app/src/a.ts" }, "/work/app")!;
  assert.deepEqual(inside, { kind: "folder", path: "/work/app" });
  assert.equal(chatToolPermissionCoveredByScopes("Edit", { file_path: "/work/app/docs/b.md" }, [inside]), true, "any edit tool in the folder");
  assert.equal(chatToolPermissionCoveredByScopes("Edit", { file_path: "/work/app/../other/b.md" }, [inside]), false);
  assert.equal(chatToolPermissionCoveredByScopes("Edit", { file_path: "/work/application/b.md" }, [inside]), false);
  const outside = chatToolPermissionScope("Edit", { file_path: "/etc/hosts" }, "/work/app")!;
  assert.deepEqual(outside, { kind: "folder", path: "/etc" });
  assert.equal(chatToolPermissionScope("Edit", { file_path: "relative.txt" }, "/work/app"), undefined);
});

test("only Bash, WebFetch and edits are scoped; a stored scope is read back only when it is one", () => {
  assert.equal(chatToolPermissionIsScoped("Bash"), true);
  assert.equal(chatToolPermissionIsScoped("NotebookEdit"), true);
  assert.equal(chatToolPermissionIsScoped("WebSearch"), false);
  assert.equal(chatToolPermissionIsScoped("mcp__atlassian__search"), false);
  assert.equal(chatToolPermissionScope("mcp__atlassian__search", {}), undefined);
  assert.deepEqual(normalizeChatToolPermissionScope({ kind: "commands", prefixes: ["ls"] }), { kind: "commands", prefixes: ["ls"] });
  assert.equal(normalizeChatToolPermissionScope({ kind: "commands", prefixes: [] }), undefined);
  assert.equal(normalizeChatToolPermissionScope({ kind: "folder", path: "/a/../b" }), undefined);
  assert.equal(normalizeChatToolPermissionScope({ kind: "domain", domain: "*" }), undefined);
});
