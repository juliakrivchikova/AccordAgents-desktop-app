import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  ClaudeFolderNotTrustedError, claudeModelProbeEnv, parseClaudeModelPickerOutput, probeClaudeModelsInFolder,
  resolveClaudeModelProbeCwd, runClaudeModelProbeInPty, runClaudeModelProbeWithExpect
} from "./cliAgents";
import { claudeModelProbeExpectScript } from "./cliAgents/models/modelLists";

// Claude Code's own config on this computer (Claude in Chrome, for one) must
// not decide these tests: an empty config folder is a fresh Claude Code.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "aa-claude-config-"));

test("parseClaudeModelPickerOutput extracts aliases and default model from picker text", () => {
  const output = [
    "\u001b[?25lSelect m\u001b[12Gdel",
    "\u001b[3G❯\u001b[5G1.\u001b[8GDefault\u001b[16G(recommended)\u001b[30G✔\u001b[33GUse\u001b[37Gthe\u001b[41Gdefault\u001b[49Gmodel\u001b[55G(currently\u001b[66GOpus\u001b[71G4.8\u001b[75G(1M",
    "\u001b[33Gcontext))\u001b[43G·\u001b[45G$5/$25\u001b[52Gper\u001b[56GMtok",
    "\u001b[5G2.\u001b[8GOpus\u001b[33GOpus\u001b[38G4.8\u001b[42Gwith\u001b[47G1M\u001b[50Gcontext",
    "\u001b[5G3.\u001b[8GFable\u001b[33GFable\u001b[39G5",
    "\u001b[5G4.\u001b[8GSonnet\u001b[33GSonnet\u001b[40G4.6",
    "\u001b[5G5.\u001b[8GSonnet\u001b[15G(1M\u001b[19Gcontext)\u001b[33GSonnet\u001b[40G4.6\u001b[44Gfor\u001b[48Glong\u001b[53Gsessions",
    "\u001b[5G6.\u001b[8GHaiku\u001b[33GHaiku\u001b[39G4.5",
    "● Enter to set · Esctocancel"
  ].join("\n");

  assert.deepEqual(parseClaudeModelPickerOutput(output).map((model) => ({
    id: model.id,
    recommended: model.recommended === true
  })), [
    { id: "opus", recommended: true },
    { id: "fable", recommended: false },
    { id: "sonnet", recommended: false },
    { id: "claude-sonnet-4-6[1m]", recommended: false },
    { id: "haiku", recommended: false }
  ]);
});

test("parseClaudeModelPickerOutput handles ConPTY rows without whitespace between items", () => {
  const output = "Select model> 1. Default (recommended) √ Opus 5 with 1M context · Best for tasks2. Opus (1M context) Opus 5 with 1M context · Best for tasks3. Fable Fable 5 · Hard tasks4. Sonnet Sonnet 5 · Routine tasks5. Sonnet5(1Mcontext)Sonnet5forlongsessions6. Haiku Haiku 4.5 · Fast● High effort Enter to s t as defaul · Esctocancel";
  assert.deepEqual(parseClaudeModelPickerOutput(output).map((model) => model.id), [
    "opus",
    "fable",
    "sonnet",
    "claude-sonnet-5[1m]",
    "haiku"
  ]);
});

test("parseClaudeModelPickerOutput keeps a Unicode cursor on a lower row out of the row above", () => {
  const output = "Select model 1. Default (recommended) ✔ Opus 5.5 · Best for tasks2. Opus Opus 5.5 · Best for tasks❯ 3. Sonnet Sonnet 5.5 · Routine tasks● Enter to set · Esc to cancel";
  const models = parseClaudeModelPickerOutput(output);
  assert.deepEqual(models.map((model) => model.id), ["opus", "sonnet"]);
  assert.equal(models.some((model) => model.label.includes("❯")), false);
});

test("parseClaudeModelPickerOutput uses the final ConPTY redraw", () => {
  const output = [
    "Select model 1. Default (recommended) ✔ Opus 5 2. Opus Opus 5 Enter to set · Esc to cancel",
    "Select model 1. Default (recommended) ✔ Opus 5 2. Opus Opus 5 3. Fable Fable 5 4. Sonnet Sonnet 5 5. Sonnet5(1Mcontext) Sonnet 5 for long sessions 6. Haiku Haiku 4.5 Enter to set · Esc to cancel"
  ].join("\n");

  assert.deepEqual(parseClaudeModelPickerOutput(output).map((model) => model.id), [
    "opus",
    "fable",
    "sonnet",
    "claude-sonnet-5[1m]",
    "haiku"
  ]);
});

test("parseClaudeModelPickerOutput drops models removed by the final ConPTY redraw", () => {
  const output = [
    "Select model 1. Default (recommended) ✔ Opus 5 2. Opus Opus 5 3. Fable Fable 5 Enter to set · Esc to cancel",
    "Select model 1. Default (recommended) ✔ Opus 5 2. Opus Opus 5 Enter to set · Esc to cancel"
  ].join("\n");

  assert.deepEqual(parseClaudeModelPickerOutput(output).map((model) => model.id), ["opus"]);
});

test("parseClaudeModelPickerOutput uses a final heading when its footer is fragmented", () => {
  const output = [
    "Select model 1. Default (recommended) ✔ Opus 5 2. Opus Opus 5 3. Fable Fable 5 Enter to set · Esc to cancel",
    "Select model 1. Default (recommended) ✔ Opus 5 2. Sonnet Sonnet 5 Enter to s et · Esc to cancel"
  ].join("\n");

  assert.deepEqual(parseClaudeModelPickerOutput(output).map((model) => model.id), ["sonnet"]);
});

test("parseClaudeModelPickerOutput uses the preceding footer when the final heading is fragmented", () => {
  const output = [
    "Select model 1. Default (recommended) ✔ Opus 5 2. Opus Opus 5 3. Fable Fable 5 Enter to set · Esc to cancel",
    "Sel ect model 1. Default (recommended) ✔ Opus 5 2. Haiku Haiku 4.5 Enter to set · Esc to cancel"
  ].join("\n");

  assert.deepEqual(parseClaudeModelPickerOutput(output).map((model) => model.id), ["haiku"]);
});

test("parseClaudeModelPickerOutput uses final rows when both redraw boundaries are fragmented", () => {
  const output = [
    "Select model 1. Default (recommended) ✔ Opus 5 2. Opus Opus 5 3. Fable Fable 5 Enter to set · Esc to cancel",
    "Sel ect model 1. Default (recommended) ✔ Opus 5 2. Sonnet Sonnet 5 Enter to s et · Esc to cancel"
  ].join("\n");

  assert.deepEqual(parseClaudeModelPickerOutput(output).map((model) => model.id), ["sonnet"]);
});

test("parseClaudeModelPickerOutput recognizes a single picker with fragmented boundaries", () => {
  const output = "Sel ect model 1. Default (recommended) ✔ Opus 5 2. Haiku Haiku 4.5 Enter to s et · Esc to cancel";

  assert.deepEqual(parseClaudeModelPickerOutput(output).map((model) => model.id), ["haiku"]);
});

test("parseClaudeModelPickerOutput ignores numbered settings warning actions", () => {
  const output = [
    "Settings Warning",
    "1. Continue",
    "2. Fix with Claude",
    "3. Exit and fix manually",
    "Enter to confirm · Esc to cancel"
  ].join("\n");

  assert.deepEqual(parseClaudeModelPickerOutput(output), []);
});

test("macOS Claude model discovery uses a full-height, system-expect-compatible PTY", () => {
  const script = claudeModelProbeExpectScript() as string;

  assert.match(script, /set stty_init "rows 40 columns 120"/);
  assert.match(script, /spawn \$env\(ACCORD_AGENTS_CLAUDE_EXECUTABLE\) --safe-mode --no-chrome/);
  assert.doesNotMatch(script, /spawn --/);
  assert.ok(script.indexOf("set stty_init") < script.indexOf("spawn $env"));
  assert.match(script, /Settings\.\*Warning/);
  assert.match(script, /Enter\.\*to\.\*confirm/);
  assert.match(script, /Transcript\.\*saving\.\*is\.\*off/);
  assert.match(script, /Enter\.\*to\.\*set\.\*Esc\.\*to\.\*cancel/);
  assert.match(script, /send "\\033"\nafter 250\nsend "\/exit\\r"\nset timeout 2/);
});

test("Claude model probe environment suppresses prompt history and session persistence", () => {
  const env = claudeModelProbeEnv({
    PATH: "/usr/bin",
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: "0",
    CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1"
  });

  assert.deepEqual(env, {
    PATH: "/usr/bin",
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1"
  });
});

test("Claude model discovery falls back when the saved repository directory no longer exists", async () => {
  const deletedDirectory = await mkdtemp(path.join(tmpdir(), "accord-claude-deleted-cwd-"));
  await rm(deletedDirectory, { recursive: true, force: true });

  assert.equal(await resolveClaudeModelProbeCwd(deletedDirectory), process.cwd());
});

test("macOS Claude model discovery passes cwd, safe env, and ignored stdin through its spawn boundary", async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    killed: false,
    exitCode: null as number | null,
    kill() {
      this.killed = true;
      return true;
    }
  });
  let launch: { command: string; args: readonly string[]; options: Record<string, any> } | undefined;
  const picker = "Select model 1. Default (recommended) ✔ Opus 4.8 2. Fable Fable 5 Enter to set · Esc to cancel";

  const probe = runClaudeModelProbeWithExpect({
    executable: "/tmp/claude-stub",
    env: {
      PATH: "/usr/bin",
      CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1"
    },
    cwd: "/tmp/trusted-repo",
    expectScript: "exit 0",
    timeoutMs: 1_000,
    spawnExpect: ((command: string, args: readonly string[], options: Record<string, any>) => {
      launch = { command, args, options };
      queueMicrotask(() => {
        stdout.write(picker);
        child.exitCode = 0;
        child.emit("exit", 0, null);
      });
      return child;
    }) as any
  });

  assert.deepEqual(parseClaudeModelPickerOutput(await probe).map((model) => model.id), ["fable"]);
  assert.equal(launch?.command, "expect");
  assert.deepEqual(launch?.args, ["-c", "exit 0"]);
  assert.equal(launch?.options.cwd, "/tmp/trusted-repo");
  assert.deepEqual(launch?.options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(launch?.options.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY, "1");
  assert.equal("CLAUDE_CODE_FORCE_SESSION_PERSISTENCE" in launch!.options.env, false);
  assert.equal(launch?.options.env.ACCORD_AGENTS_CLAUDE_EXECUTABLE, "/tmp/claude-stub");
});

test("macOS Claude model discovery keeps a captured picker when process exit is late", async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let killed = false;
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    killed: false,
    exitCode: null as number | null,
    kill() {
      killed = true;
      this.killed = true;
      return true;
    }
  });
  const picker = "Select model 1. Default (recommended) ✔ Opus 4.8 2. Fable Fable 5 Enter to set · Esc to cancel";

  const output = await runClaudeModelProbeWithExpect({
    executable: "/tmp/claude-stub",
    env: {},
    cwd: "/tmp/trusted-repo",
    expectScript: "set timeout -1",
    timeoutMs: 20,
    spawnExpect: (() => {
      queueMicrotask(() => stdout.write(picker));
      return child;
    }) as any
  });

  assert.deepEqual(parseClaudeModelPickerOutput(output).map((model) => model.id), ["fable"]);
  assert.equal(killed, true);
});

test("macOS Claude model discovery bounds captured output", async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let killed = false;
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    killed: false,
    exitCode: null as number | null,
    kill() {
      killed = true;
      this.killed = true;
      return true;
    }
  });

  const probe = runClaudeModelProbeWithExpect({
    executable: "/tmp/claude-stub",
    env: {},
    cwd: "/tmp/trusted-repo",
    expectScript: "set timeout -1",
    timeoutMs: 1_000,
    maxOutputBytes: 16,
    spawnExpect: (() => {
      queueMicrotask(() => stdout.write("x".repeat(17)));
      return child;
    }) as any
  });

  await assert.rejects(probe, /exceeded 16 bytes/);
  assert.equal(killed, true);
});

test("macOS Claude model discovery executes the generated program through system Expect", { timeout: 10_000 }, async (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS system Expect integration");
    return;
  }
  try {
    await access("/usr/bin/expect");
  } catch {
    t.skip("/usr/bin/expect is unavailable");
    return;
  }

  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-model-probe-"));
  try {
    const stubProgram = `
printf 'STUB_CWD=%s\\r\\n' "$PWD"
printf 'STUB_SKIP=%s\\r\\n' "\${CLAUDE_CODE_SKIP_PROMPT_HISTORY-unset}"
printf 'STUB_FORCE=%s\\r\\n' "\${CLAUDE_CODE_FORCE_SESSION_PERSISTENCE-unset}"
if test -t 0; then printf 'STUB_TTY=yes\\r\\n'; else printf 'STUB_TTY=no\\r\\n'; fi
printf 'STUB_SIZE=%s\\r\\n' "$(stty size 2>/dev/null)"
printf 'Claude ready\\r\\n'
while IFS= read -r line; do
  case "$line" in
    *"/model"*) printf 'Select model\\r\\n1. Default (recommended) Opus 4.8\\r\\n2. Fable Fable 5\\r\\nEnter to set - Esc to cancel\\r\\n' ;;
    *"/exit"*) exit 0 ;;
  esac
done
`;

    const output = await runClaudeModelProbeWithExpect({
      executable: "/bin/sh",
      env: {
        ...process.env,
        CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1",
        ACCORD_AGENTS_CLAUDE_STUB_PROGRAM: stubProgram
      },
      cwd: fixtureDir,
      expectCommand: "/usr/bin/expect",
      expectScript: claudeModelProbeExpectScript(
        "-c $env(ACCORD_AGENTS_CLAUDE_STUB_PROGRAM)"
      ) as string,
      timeoutMs: 5_000
    });

    const expectedCwd = await realpath(fixtureDir);
    assert.match(output, new RegExp(`STUB_CWD=${expectedCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(output, /STUB_SKIP=1/);
    assert.match(output, /STUB_FORCE=unset/);
    assert.match(output, /STUB_TTY=yes/);
    assert.match(output, /STUB_SIZE=40 120/);
    assert.deepEqual(parseClaudeModelPickerOutput(output).map((model) => model.id), ["fable"]);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("macOS Claude model discovery continues past settings warnings before opening the picker", { timeout: 10_000 }, async (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS system Expect integration");
    return;
  }
  try {
    await access("/usr/bin/expect");
  } catch {
    t.skip("/usr/bin/expect is unavailable");
    return;
  }

  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-claude-model-warning-"));
  try {
    const stubProgram = `
printf 'Settings Warning\\r\\n'
printf 'permissions.allow: Invalid permission rule "WebFetch*" was skipped\\r\\n'
printf '1. Continue\\r\\n2. Fix with Claude\\r\\n3. Exit and fix manually\\r\\n'
printf 'Enter to confirm - Esc to cancel\\r\\n'
warning_pending=1
while IFS= read -r line; do
  if test "$warning_pending" = 1; then
    warning_pending=0
    printf 'Safe mode: all customizations are disabled\\r\\n'
    printf 'Transcript saving is off\\r\\n'
    continue
  fi
  case "$line" in
    *"/model"*) printf 'Select model\\r\\n1. Default (recommended) Opus 5\\r\\n2. Fable Fable 5.1\\r\\nEnter to set - Esc to cancel\\r\\n' ;;
    *"/exit"*) exit 0 ;;
  esac
done
`;

    const output = await runClaudeModelProbeWithExpect({
      executable: "/bin/sh",
      env: {
        ...process.env,
        ACCORD_AGENTS_CLAUDE_STUB_PROGRAM: stubProgram
      },
      cwd: fixtureDir,
      expectCommand: "/usr/bin/expect",
      expectScript: claudeModelProbeExpectScript(
        "-c $env(ACCORD_AGENTS_CLAUDE_STUB_PROGRAM)"
      ) as string,
      timeoutMs: 5_000
    });

    assert.match(output, /Settings Warning/);
    assert.deepEqual(parseClaudeModelPickerOutput(output).map((model) => model.id), ["fable"]);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Windows Claude model discovery drives only the non-persistent interactive model picker", async () => {
  const writes: string[] = [];
  let launch: { executable: string; args: string[]; cwd: string; env: Record<string, string> } | undefined;
  let onData: ((data: string) => void) | undefined;
  let onExit: ((event: { exitCode: number }) => void) | undefined;
  const output = [
    "Select model",
    "1. Default (recommended) ✔ Sonnet 4.6",
    "2. Opus Opus 4.8",
    "3. Sonnet Sonnet 4.6",
    "● Enter to set · Esc to cancel"
  ].join("\r\n");

  const probe = runClaudeModelProbeInPty({
    executable: "C:\\Program Files\\Claude\\claude.exe",
    env: { PATH: "C:\\Windows\\System32", CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1", NO_COLOR: "1" },
    cwd: "C:\\trusted\\repo",
    timeoutMs: 1_000,
    initialDelayMs: 0,
    pickerSettleDelayMs: 0,
    exitDelayMs: 0,
    spawnPty: (executable, args, options) => {
      launch = { executable, args, cwd: options.cwd, env: options.env };
      queueMicrotask(() => onData?.("Safe mode: customizations disabled\r\nTranscript saving is off"));
      return {
        write: (data) => {
          writes.push(data);
          if (data === "/model\r") {
            queueMicrotask(() => onData?.(output));
          } else if (data === "/exit\r") {
            queueMicrotask(() => onExit?.({ exitCode: 0 }));
          }
        },
        kill: () => undefined,
        onData: (listener) => {
          onData = listener;
          return { dispose: () => undefined };
        },
        onExit: (listener) => {
          onExit = listener;
          return { dispose: () => undefined };
        }
      };
    }
  });

  const transcript = await probe;
  assert.deepEqual(launch, {
    executable: "C:\\Program Files\\Claude\\claude.exe",
    args: ["--safe-mode", "--no-chrome"],
    cwd: "C:\\trusted\\repo",
    env: {
      PATH: "C:\\Windows\\System32",
      CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
      TERM: "xterm-256color"
    }
  });
  assert.deepEqual(writes, ["/model\r", "\u001b", "/exit\r"]);
  assert.deepEqual(parseClaudeModelPickerOutput(transcript).map((model) => model.id), ["opus", "sonnet"]);
  assert.equal(writes.some((value) => !["/model\r", "\u001b", "/exit\r"].includes(value)), false);
});

// Claude Code 2.1.316's folder trust question as ConPTY drew it (recorded
// 2026-11-10; only the folder is replaced). The highlight starts on "No, exit".
const claudeTrustQuestion = (folder: string): string => "\u001b[38;2;255;193;7m\r\n" + "─".repeat(120)
  + `\u001b[1m\u001b[3;2HAccessing\u001b[1Cworkspace:\u001b[m\u001b[1m\u001b[5;2H${folder}\u001b[22m`
  + "\u001b[8;2HQuick\u001b[1Csafety\u001b[1Ccheck:\u001b[1CIs\u001b[1Cthis\u001b[1Ca\u001b[1Cproject\u001b[1Cyou\u001b[1Ccreated\u001b[1Cor\u001b[1Cone\u001b[1Cyou\u001b[1Ctrust?"
  + "\u001b[1C(Like\u001b[1Cyour\u001b[1Cown\u001b[1Ccode,\u001b[1Ca\u001b[1Cwell-known\u001b[1Copen\u001b[1Csource\u001b[9;2Hproject,\u001b[1Cor\u001b[1Cwork\u001b[1Cfrom\u001b[1Cyour\u001b[1Cteam)."
  + "\u001b[1CIf\u001b[1Cnot,\u001b[1Ctake\u001b[1Ca\u001b[1Cmoment\u001b[1Cto\u001b[1Creview\u001b[1Cwhat's\u001b[1Cin\u001b[1Cthis\u001b[1Cfolder\u001b[1Cfirst."
  + "\u001b[11;2HClaude\u001b[1CCode'll\u001b[1Cbe\u001b[1Cable\u001b[1Cto\u001b[1Cread,\u001b[1Cedit,\u001b[1Cand\u001b[1Cexecute\u001b[1Cfiles\u001b[1Chere."
  + "\u001b[38;2;153;153;153m\u001b[13;2HSecurity\u001b[1Cguide\u001b[38;2;177;185;249m\u001b[15;2H❯\u001b[1CNo,\u001b[1Cexit\u001b[m\u001b[16;4HYes,\u001b[1CI\u001b[1Ctrust\u001b[1Cthis\u001b[1Cfolder"
  + "\u001b[38;2;153;153;153m\u001b[18;2HEnter\u001b[1Cto\u001b[1Cconfirm\u001b[1C·\u001b[1CEsc\u001b[1Cto\u001b[1Ccancel";

// What the same Claude Code drew after one Down (recorded with the question above).
const claudeTrustDownRedraw = ["\u001b[m\u001b[15;2H \u001b[1CNo, exit\u001b[38;2;177;185;249m\u001b[16;2H❯\u001b[1CYes, I trust this folder", "\u001b[m"];

const windowsProbe = {
  executable: "C:\\Program Files\\Claude\\claude.exe",
  env: { PATH: "C:\\Windows\\System32" },
  timeoutMs: 1_000,
  initialDelayMs: 0,
  pickerSettleDelayMs: 0,
  exitDelayMs: 0,
  trustKeyIntervalMs: 0
};

/** A fake ConPTY: `first` is drawn at start, and each press of a key draws its
 *  next list of chunks (an empty list: the key drew nothing). */
function fakeClaudePty(first: string[], replies: Record<string, string[][]>) {
  const writes: string[] = [];
  const state = { killed: false };
  let onData: ((data: string) => void) | undefined;
  let onExit: ((event: { exitCode: number }) => void) | undefined;
  const draw = (chunks: string[] = []): void => {
    for (const chunk of chunks) queueMicrotask(() => onData?.(chunk));
  };
  const spawnPty = () => {
    draw(first);
    return {
      write: (data: string) => {
        writes.push(data);
        draw(replies[data]?.shift());
        if (data === "/exit\r") queueMicrotask(() => onExit?.({ exitCode: 0 }));
      },
      kill: () => { state.killed = true; },
      onData: (listener: (data: string) => void) => {
        onData = listener;
        return { dispose: () => undefined };
      },
      onExit: (listener: (event: { exitCode: number }) => void) => {
        onExit = listener;
        return { dispose: () => undefined };
      }
    };
  };
  return { spawnPty, writes, state };
}

test("Windows Claude model discovery refuses a folder trust prompt outside the app's own folder", async () => {
  for (const ownFolder of [undefined, "C:\\app\\probe"]) {
    const pty = fakeClaudePty([claudeTrustQuestion("C:\\untrusted\\repo")], {});
    const probe = runClaudeModelProbeInPty({ ...windowsProbe, cwd: "C:\\untrusted\\repo", ownFolder, spawnPty: pty.spawnPty });
    // The class is what sends the probe on to the app's own folder.
    await assert.rejects(probe, (error) => error instanceof ClaudeFolderNotTrustedError && error.folder === "C:\\untrusted\\repo");
    assert.deepEqual(pty.writes, []);
    assert.equal(pty.state.killed, true);
  }
});

test("Windows Claude model discovery answers Yes in the app's own folder, after a lost Down, and ignores the question's late footer", async () => {
  const pty = fakeClaudePty([claudeTrustQuestion("C:\\app\\probe")], {
    "\u001b[B": [[], claudeTrustDownRedraw],
    // A redraw can deliver the question's "Esc to cancel" after Yes was chosen.
    "\r": [["\u001b[18;2HEnter\u001b[1Cto\u001b[1Cconfirm\u001b[1C·\u001b[1CEsc\u001b[1Cto\u001b[1Ccancel", "Safe mode: customizations disabled\r\nTranscript saving is off"]],
    "/model\r": [["Select model\r\n1. Default (recommended) ✔ Opus 5.5\r\n2. Opus Opus 5.5\r\n3. Haiku Haiku 5.5\r\n● Enter to set · Esc to cancel"]]
  });

  const transcript = await runClaudeModelProbeInPty({ ...windowsProbe, cwd: "C:\\app\\probe", ownFolder: "C:\\app\\probe", spawnPty: pty.spawnPty });
  assert.deepEqual(pty.writes, ["\u001b[B", "\u001b[B", "\r", "/model\r", "\u001b", "/exit\r"]);
  assert.deepEqual(parseClaudeModelPickerOutput(transcript).map((model) => model.id), ["opus", "haiku"]);
});

test("Claude model discovery reads an untrusted or missing project folder's models in the app's own folder, its own git work tree", async () => {
  // userData inside a repository: Claude Code would record trust for the
  // whole repository unless the app's folder is a work tree of its own.
  const root = await mkdtemp(path.join(tmpdir(), "accord-claude-probe-folder-"));
  const project = path.join(root, "project");
  const ownFolder = path.join(root, "app", "claude-model-probe");
  await mkdir(project);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  try {
    // No project folder: the app's own folder, not the folder the app started in.
    assert.equal(await resolveClaudeModelProbeCwd(undefined, ownFolder), ownFolder);
    const cases: Array<{ name: string; cwd: string; project: "trusted" | "untrusted" | "broken"; calls: string[]; result: string | RegExp }> = [
      { name: "trusted project", cwd: project, project: "trusted", calls: [project], result: "models in project" },
      { name: "untrusted project", cwd: project, project: "untrusted", calls: [project, ownFolder], result: "models in app folder" },
      { name: "project probe failing otherwise", cwd: project, project: "broken", calls: [project], result: /timed out/ },
      { name: "no project", cwd: ownFolder, project: "trusted", calls: [ownFolder], result: "models in app folder" }
    ];
    for (const item of cases) {
      await rm(ownFolder, { recursive: true, force: true });
      const calls: string[] = [];
      const run = probeClaudeModelsInFolder(item.cwd, ownFolder, async (folder) => {
        calls.push(folder);
        if (folder === ownFolder) {
          const workTree = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: ownFolder, encoding: "utf8" }).trim();
          assert.equal(path.resolve(workTree), await realpath(ownFolder), item.name);
          return "models in app folder";
        }
        if (item.project === "untrusted") throw new ClaudeFolderNotTrustedError(folder);
        if (item.project === "broken") throw new Error("Claude model picker probe timed out.");
        return "models in project";
      });
      if (typeof item.result === "string") assert.equal(await run, item.result, item.name);
      else await assert.rejects(run, item.result, item.name);
      assert.deepEqual(calls, item.calls, item.name);
    }

    // A link in place of the app's folder would carry the trust to its target.
    const linked = path.join(root, "app", "linked-probe");
    await symlink(project, linked, "junction");
    let probed = false;
    await assert.rejects(probeClaudeModelsInFolder(linked, linked, async () => { probed = true; return ""; }));
    assert.equal(probed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows Claude model discovery bounds captured output", async () => {
  let killed = false;
  let onData: ((data: string) => void) | undefined;

  const probe = runClaudeModelProbeInPty({
    executable: "C:\\Program Files\\Claude\\claude.exe",
    env: { PATH: "C:\\Windows\\System32" },
    cwd: "C:\\trusted\\repo",
    timeoutMs: 1_000,
    initialDelayMs: 0,
    pickerSettleDelayMs: 0,
    exitDelayMs: 0,
    maxOutputBytes: 16,
    spawnPty: () => {
      queueMicrotask(() => onData?.("x".repeat(17)));
      return {
        write: () => undefined,
        kill: () => { killed = true; },
        onData: (listener) => {
          onData = listener;
          return { dispose: () => undefined };
        },
        onExit: () => ({ dispose: () => undefined })
      };
    }
  });

  await assert.rejects(probe, /exceeded 16 bytes/);
  assert.equal(killed, true);
});
