// Real UI: send a task, close the controller, let the machine post its reply to
// the public sealed mailbox, stop that QA machine, then return the controller.
// The reply must arrive with the machine still offline (no live hello).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { attach } = require("../../cdp.cjs");
const termination = require("../../../dist/main/main/services/processTermination.js");

const repo = path.resolve(__dirname, "../../..");
const port = Number(process.env.ELECTRON_CDP_PORT || 9224);
const desktopProfile = process.env.QA_DESKTOP_PROFILE;
const machineProfile = process.env.QA_MACHINE_PROFILE;
const machinePid = Number(process.env.QA_MACHINE_PID);
const handle = process.env.QA_MACHINE_HANDLE;
for (const profile of [desktopProfile, machineProfile]) {
  assert.ok(profile?.startsWith("/private/tmp/accordagents-"), "Use isolated QA profiles only");
}
assert.ok(Number.isSafeInteger(machinePid) && machinePid > 1 && handle, "Pass the captured QA machine PID and handle");
const marker = process.env.QA_RESUME_MARKER || `BUFFERED_REPLY_${randomUUID().replace(/-/g, "")}`;
assert.match(marker, /^BUFFERED_REPLY_[a-f0-9]{32}$/);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await check(); if (result) return result; await sleep(400); }
  throw new Error("QA condition timed out");
}
function sourceSql(sql) {
  return JSON.parse(execFileSync("sqlite3", ["-readonly", "-json", "-cmd", ".timeout 5000", path.join(machineProfile, "accordagents.sqlite3")], { input: sql, encoding: "utf8" }) || "[]");
}

(async () => {
  let client;
  if (!process.env.QA_RESUME_MARKER) {
    client = await attach({ port });
    console.log(JSON.stringify({ marker }));
    const prompt = `@${handle} Run this command in the foreground: python3 -c "import time; time.sleep(30); print('${marker}')". After it finishes, reply with only the printed marker.`;
    if (process.env.QA_NEW_CHAT === "1") {
      await client.evaluate(`(() => {
        const button = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === 'New chat');
        if (!button) throw new Error('New chat button missing'); button.click();
      })()`);
      await client.click('.new-chat-participant-trigger');
      await client.click(`[aria-label="Add @${handle}"]`);
      await client.evaluate('document.body.click()');
      await client.fill('.new-chat-prompt', prompt);
      await client.click('.new-chat-send');
    } else {
      await client.fill('textarea[placeholder="Message @name, /name, or #path..."]', prompt);
      await client.click('[aria-label="Send message"]');
    }
  // A CLI's launch prompt can contain the same text: match the executable,
  // never merely a command string occurring somewhere in another argv.
    await until(() => execFileSync("/bin/ps", ["-axo", "command="], { encoding: "utf8" }).split("\n")
      .some((line) => /^\s*(?:\S*\/)?python(?:3(?:\.\d+)?)?\s+-c\s/i.test(line) && line.includes(marker)));
    await client.send("Browser.close").catch(() => undefined);
    client.close();
    console.log("Controller closed while the native command was running.");
  }
  const delivered = await until(() => sourceSql(`
    select e.conversation_id as conversationId, e.event_id as eventId, json_extract(e.payload_json, '$.runId') as runId
    from device_event_outbox o join chat_events e on e.event_id = o.event_id
    where o.delivered_at is not null and o.acknowledged_at is null
      and e.kind = 'machine.turn.finished'
      and exists(select 1 from json_each(e.payload_json, '$.messages') m
        where json_extract(m.value, '$.role') = 'participant'
          and json_extract(m.value, '$.status') = 'done'
          and instr(json_extract(m.value, '$.content'), '${marker}') > 0)
    order by o.rowid desc limit 1;
  `)[0]);
  const command = execFileSync("/bin/ps", ["-p", String(machinePid), "-o", "command="], { encoding: "utf8" });
  assert.ok(command.includes("dist/main/machine/main.js") && command.includes(machineProfile), "QA process identity must still match");
  const identity = termination.capturePosixProcessIdentity(machinePid);
  assert.ok(identity, "Must capture process identity before stopping it");
  const captured = [identity, ...termination.capturePosixDescendants(machinePid, [], identity)];
  termination.terminateCapturedPosixProcesses(captured, "SIGTERM");
  await sleep(800);
  if (termination.hasLiveCapturedPosixProcesses(captured)) termination.terminateCapturedPosixProcesses(captured, "SIGKILL");
  await until(() => !termination.hasLiveCapturedPosixProcesses(captured), 5000);
  console.log("Machine stopped after the relay accepted the completed reply; restarting controller only.");
  const log = fs.openSync(path.join(desktopProfile, "qa-mailbox-return.log"), "a");
  const child = spawn(process.execPath, [path.join(repo, "node_modules/electron/cli.js"), repo, `--remote-debugging-port=${port}`,
    "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"], {
    cwd: repo, detached: true, stdio: ["ignore", log, log], env: { ...process.env, ACCORDAGENTS_USER_DATA_DIR: desktopProfile }
  });
  child.unref();
  console.log(JSON.stringify({ desktopPid: child.pid }));
  await until(async () => { try { client = await attach({ port, timeoutMs: 1000 }); return true; } catch { return false; } });
  await until(async () => {
    const result = await client.evaluate(`(async () => {
      if (!window.consensus) return false;
      const conversation = await window.consensus.getConversation(${JSON.stringify(delivered.conversationId)});
      return conversation?.messages.some(m => m.role === "participant" && m.status === "done" && m.content.includes(${JSON.stringify(marker)})) &&
        ${process.env.QA_NEW_CHAT === "1" ? "!conversation.metadata.running && !(conversation.metadata.activeRunIds?.length) &&" : ""}
        !conversation.metadata.activeRunIds?.includes(${JSON.stringify(delivered.runId)}) &&
        !(await window.consensus.listMachines()).machines.some(machine => machine.pendingRuns?.some(run => run.runId === ${JSON.stringify(delivered.runId)}));
    })()`, { awaitPromise: true });
    return result.result.value;
  });
  // Open the returned chat through the actual history row before taking proof.
  const conversationTitle = await client.evaluate(`(async () => (await window.consensus.getConversation(${JSON.stringify(delivered.conversationId)})).title)()`, { awaitPromise: true });
  await until(async () => (await client.evaluate(`(() => {
    const row = [...document.querySelectorAll('.sidebar-history-item')].find(el => el.textContent.includes(${JSON.stringify(conversationTitle.result.value)}));
    if (!row) return false;
    row.click();
    return true;
  })()`)).result.value);
  await until(async () => (await client.evaluate(`document.body.innerText.includes(${JSON.stringify(marker)})`)).result.value);
  if (process.env.QA_NEW_CHAT === "1") {
    await until(async () => (await client.evaluate(`(() => {
      const row = document.querySelector('.sidebar-history-item.is-selected');
      return row && row.getAttribute('data-running') !== 'true' && row.getAttribute('aria-busy') !== 'true';
    })()`)).result.value);
  }
  const screenshot = path.join(repo, "screenshots/qa-machine-mailbox-return.png");
  fs.mkdirSync(path.dirname(screenshot), { recursive: true });
  const shot = await client.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(screenshot, Buffer.from(shot.data, "base64"));
  client.close();
  console.log(JSON.stringify({ status: "PASS", conversationId: delivered.conversationId, eventId: delivered.eventId, marker, screenshot, machineOffline: true }));
})().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
