const fs = require("fs");
const path = require("path");
const { attach } = require(path.resolve(process.argv[2], "scripts/cdp.cjs"));
const machineId = fs.readFileSync("/private/tmp/accordagents-machine-qa/machine-id.txt", "utf8").trim();
const handle = "nora-machine-default";
const t0 = Date.now(); const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function evalJson(client, expr, timeoutMs = 15000) {
  const r = await client.evaluate(`JSON.stringify((() => { ${expr} })())`, {}, { timeoutMs });
  return JSON.parse(r.result.value);
}
async function evalAsync(client, expr, timeoutMs = 30000) {
  const r = await client.evaluate(`(async () => { try { const v = await (${expr}); return JSON.stringify({ ok: true, v }); } catch (e) { return JSON.stringify({ ok: false, e: String(e && e.message || e) }); } })()`, { awaitPromise: true }, { timeoutMs });
  return JSON.parse(r.result.value);
}
async function snapshot(client, id) {
  const r = await evalAsync(client, `(async () => { const c = await window.consensus.getConversation(${JSON.stringify(id)}); return { running: c.metadata.running, approvals: (c.metadata.pendingAppToolApprovals || []).map((a) => ({ id: a.id, status: a.status, tool: a.toolName, summary: (a.summary || "").slice(0, 120), home: a.homeMachineId })), messages: c.messages.filter((m) => m.role === "participant").map((m) => ({ status: m.status, text: (m.content || "").slice(0, 140) })) }; })()`);
  return r.ok ? r.v : null;
}
(async () => {
  const client = await attach({ port: 9223 });
  // A default-mode member: tool permissions prompt through the app's permission tool.
  const saved = await evalAsync(client, `window.consensus.saveChatParticipantConfig({ handle: ${JSON.stringify(handle)}, roleConfigId: "software-engineer", behaviorRuleIds: [], kind: "claude-code", model: "sonnet", agentMode: "default", permissions: { repoRead: true, workspaceWrite: false, webAccess: false, requestParticipants: "deny", requestCompaction: "ask", shell: { enabled: false, rules: [] } }, remoteExecution: "local", homeMachineId: ${JSON.stringify(machineId)}, skipToolchainPreflight: false, autoWatchEnabled: false })`);
  console.log(stamp(), "preset saved:", saved.ok || saved.e);
  const before = await evalAsync(client, `(async () => (await window.consensus.listConversations()).map((c) => c.id))()`);
  const known = new Set(before.v || []);
  await evalJson(client, `const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "New chat"); if (b) b.click(); return Boolean(b);`);
  await sleep(700);
  await client.click(".new-chat-participant-trigger"); await sleep(700);
  const added = await evalJson(client, `const b = [...document.querySelectorAll("[aria-label]")].find((x) => x.getAttribute("aria-label") === "Add @${handle}"); if (b) b.click(); return Boolean(b);`);
  console.log(stamp(), "added member:", added);
  await sleep(300); await client.evaluate(`document.body.click()`);
  await client.fill(".new-chat-prompt", `@${handle} Use the WebFetch tool to fetch https://example.com and tell me the page title. If the tool needs a permission, request it through the permission tool and wait for my decision.`);
  await sleep(300); await client.click(".new-chat-send"); console.log(stamp(), "sent");
  let id;
  for (let i = 0; i < 30 && !id; i += 1) { const l = await evalAsync(client, `(async () => (await window.consensus.listConversations()).map((c) => c.id))()`); id = (l.v || []).find((x) => !known.has(x)); if (!id) await sleep(500); }
  console.log(stamp(), "conversation", id);
  let state; let pending;
  for (let i = 0; i < 120; i += 1) {
    state = await snapshot(client, id);
    pending = state?.approvals.find((a) => a.status === "pending");
    if (pending) break;
    if (state?.messages.some((m) => m.status !== "pending")) break;
    await sleep(1500);
  }
  console.log(stamp(), "approvals:", JSON.stringify(state?.approvals));
  if (!pending) { console.log(stamp(), "no pending approval reached the desktop; messages:", JSON.stringify(state?.messages)); process.exit(1); }
  const cardVisible = await evalJson(client, `return Boolean([...document.querySelectorAll("button")].find((b) => /approve|allow/i.test(b.textContent || "")));`);
  console.log(stamp(), "approval card with an approve/allow button visible in the UI:", cardVisible, "home:", pending.home);
  let clicked = await evalJson(client, `const card = document.querySelector(".chat-app-tool-approval-body") || document.body; const b = [...card.querySelectorAll("button")].find((b) => /approve|allow/i.test((b.textContent || "").trim()) && !/deny|for chat|always/i.test((b.textContent || "").trim())) || [...card.querySelectorAll("button")].find((b) => /approve|allow/i.test((b.textContent || "").trim())); if (b) { b.click(); return (b.textContent || "").trim(); } return null;`);
  console.log(stamp(), "selected option:", clicked);
  await sleep(300);
  const submitted = await evalJson(client, `const b = document.querySelector(".chat-approval-submit"); if (b && !b.disabled) { b.click(); return (b.textContent || "").trim() || "submit"; } return null;`);
  console.log(stamp(), "submitted via card button:", submitted);
  if (submitted) { clicked = submitted; }
  if (!clicked) {
    const decided = await evalAsync(client, `window.consensus.respondToChatAppToolApproval({ conversationId: ${JSON.stringify(id)}, approvalId: ${JSON.stringify(pending.id)}, approve: true, scope: "once" })`);
    console.log(stamp(), "decided via bridge:", decided.ok || decided.e);
  }
  let reply;
  for (let i = 0; i < 80; i += 1) {
    state = await snapshot(client, id);
    const resolved = state?.approvals.every((a) => a.status !== "pending");
    reply = state?.messages.filter((m) => m.status === "done").find((m) => /example/i.test(m.text) && !/awaiting|request/i.test(m.text.slice(0, 40)));
    if (resolved && reply) break;
    await sleep(1500);
  }
  reply = reply || state?.messages[state.messages.length - 1];
  console.log(stamp(), "approvals now:", JSON.stringify(state?.approvals));
  console.log(stamp(), "reply:", JSON.stringify(reply));
  const ok = Boolean(reply && reply.status === "done" && /example/i.test(reply.text) && state.approvals.every((a) => a.status !== "pending"));
  console.log(stamp(), ok ? "MACHINE APPROVAL: PASS" : "MACHINE APPROVAL: FAIL");
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("driver error", e); process.exit(3); });
