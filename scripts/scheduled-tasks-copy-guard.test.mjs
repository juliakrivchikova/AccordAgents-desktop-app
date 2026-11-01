import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The User calls the feature "Scheduled Tasks". What she sees must say so:
// the settings page, its notices in chat, the approval card on the desktop
// and on the phone, and errors her own actions can show. Members must call
// it a scheduled task too, so the skill, the tool descriptions and the notice
// a woken member gets say so. Code names, tool names, the script API and the
// word for the code inside a task keep "script".
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const userFacingFiles = [
  "src/main/main.ts",
  "src/main/services/scripts.ts",
  "src/main/services/machineLink.ts",
  "src/main/services/machineHost.ts",
  "src/main/services/machineApprovalExecutor.ts",
  "src/shared/mobileControlCards.ts"
];

const staleSnippets = [
  "Settings → Scripts",
  "label: \"Scripts\"",
  "? \"Scripts\"",
  "Scheduled scripts</h2>",
  "No scheduled scripts yet",
  "\"Delete script\"",
  "a scheduled script`",
  "\"Proposes a scheduled script\"",
  "\"Scheduled script\"",
  "Delete the script, its keys",
  "The script reads them from its environment",
  "the script's code yet",
  "A script that runs code is approved",
  "the scheduled script \"",
  "`Scheduled scripts on ",
  "without scheduled scripts",
  "does not host scheduled scripts",
  "switched-on scheduled scripts",
  "ask for the script again",
  "Approve the script"
];

async function rendererSources(dir) {
  const files = [];
  for (const entry of await readdir(path.join(repoRoot, dir), { withFileTypes: true })) {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await rendererSources(relative));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(relative);
  }
  return files;
}

test("what the User sees calls scheduled scripts Scheduled Tasks", async () => {
  const files = [...await rendererSources("src/renderer"), ...userFacingFiles];
  const hits = [];
  for (const file of files) {
    const lines = (await readFile(path.join(repoRoot, file), "utf8")).split("\n");
    lines.forEach((line, index) => {
      for (const snippet of staleSnippets) {
        if (line.includes(snippet)) hits.push(`${file}:${index + 1}: ${snippet}`);
      }
    });
  }
  const chat = await readFile(path.join(repoRoot, "src/main/services/chat.ts"), "utf8");
  if (chat.includes("Scheduled script approval needed")) hits.push("src/main/services/chat.ts: Scheduled script approval needed");
  assert.deepEqual(hits, []);
});

const flat = (text) => text.replace(/\s+/g, " ");

test("members are told to call it a scheduled task", async () => {
  const read = async (file) => flat(await readFile(path.join(repoRoot, file), "utf8"));
  const skill = await read("src/main/appSkills/automations/SKILL.md");
  const description = skill.split(" --- ")[0];
  assert.doesNotMatch(description, /scheduled scripts?|propos\w* (the|a) script/i);
  assert.match(description, /Set up a scheduled task in AccordAgents/);
  assert.match(skill, /When you talk to the User, say "scheduled task"/);
  assert.doesNotMatch(skill, /what the script does/i);

  const tools = await read("src/shared/appMcpToolContracts.ts");
  assert.doesNotMatch(tools, /Scheduled Scripts?\b|scheduled scripts?\b|why a script is failing/);
  assert.match(tools, /"title": "Request Scheduled Task Change"/);

  const chatLines = (await readFile(path.join(repoRoot, "src/main/services/chat.ts"), "utf8")).split("\n");
  const stale = chatLines
    .map((line, index) => ({ line: line.trim(), at: index + 1 }))
    .filter(({ line }) => !/^(\/\/|\/\*|\*)/.test(line) && /\b[Ss]cheduled scripts?\b/.test(line))
    .map(({ line, at }) => `chat.ts:${at}: ${line.slice(0, 120)}`);
  assert.deepEqual(stale, []);
  assert.match(flat(chatLines.join("\n")), /When you talk to the User, call it a scheduled task\./);
});

test("the settings menu and page title read Scheduled Tasks", async () => {
  const sidebar = await readFile(path.join(repoRoot, "src/renderer/components/settings/settings-sidebar.tsx"), "utf8");
  const view = await readFile(path.join(repoRoot, "src/renderer/components/settings/settings-view.tsx"), "utf8");
  assert.match(sidebar, /section: "scripts", label: "Scheduled Tasks"/);
  assert.match(view, /props\.section === "scripts"\s*\?\s*"Scheduled Tasks"/);
});
