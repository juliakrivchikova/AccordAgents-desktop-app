import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { consoleIntegration, localVariablesIntegration } from "@sentry/node-core";
import {
  CRASH_REPORT_EXCLUDED_INTEGRATIONS,
  CRASH_REPORT_MAX_TEXT,
  scrubCrashReportBreadcrumb,
  scrubCrashReportEvent,
  scrubCrashReportText,
  scrubSerializedUsageLogs,
  scrubUsageLog,
  type CrashReportEvent
} from "./crashReportPrivacy";

const HOME = "/Users/julia";

function scrub(text: string): string {
  return scrubCrashReportText(text, HOME);
}

test("file paths in error text are removed, whoever's home they are in", () => {
  assert.equal(scrub("ENOENT: no such file or directory, open '/Users/julia/work/secret-plan/notes.md'"), "ENOENT: no such file or directory, open '[path]'");
  // An unquoted absolute or drive path may contain spaces, so it runs to the next stop.
  assert.equal(scrub("git -C /home/other/repo diff failed"), "git -C [path]");
  assert.equal(scrub("spawn C:\\Users\\Julia\\bin\\codex.exe ENOENT"), "spawn [path]");
  assert.equal(scrub("cannot read ./src/private/file.ts"), "cannot read [path]");
});

test("paths with spaces are removed whole", () => {
  assert.equal(scrub("open '/Users/julia/Library/Mobile Documents/com~apple~CloudDocs/Clients/Acme Corp/plan.md'"), "open '[path]'");
  assert.equal(
    scrub("ENOENT: open '/Users/julia/Library/Application Support/AccordAgents/chats/1889f7e6/attachments/Taxes 2026 draft.pdf'"),
    "ENOENT: open '[path]'"
  );
  assert.equal(scrub("git -C /Users/julia/My Projects/Secret Client/repo diff failed"), "git -C [path]");
  assert.equal(scrub("spawn /Volumes/Work Drive/Acme Corp/bin/claude ENOENT"), "spawn [path]");
  assert.equal(scrub("spawn 'C:\\Users\\Julia\\My Documents\\Client X\\codex.exe' ENOENT"), "spawn '[path]' ENOENT");
  assert.equal(scrub("spawn C:\\Users\\Julia\\My Documents\\Client X\\codex.exe"), "spawn [path]");
  assert.equal(scrub("load file:///Volumes/Work/client-acme/plan.md failed"), "load [link] failed");
  assert.equal(scrub("{\"cwd\":\"/Volumes/Work/Acme Corp/repo\"}"), "{\"cwd\":\"[path]\"}");
});

test("Windows, network, list and relative paths are removed too", () => {
  assert.equal(scrub("fatal: not a git repository: D:/Clients/Acme Merger/repo/.git"), "fatal: not a git repository: [path]");
  assert.equal(scrub("EACCES \\\\fileserver\\Legal\\Acme Merger\\plan.docx"), "EACCES [path]");
  assert.equal(scrub("PATH=/usr/bin:/Volumes/Work/acme-secret/bin"), "PATH=[path]:[path]");
  assert.equal(scrub("File not found: clients/acme/merger-plan.md"), "File not found: [path]");
  assert.equal(scrub("pathspec 'clients/acme/merger-plan.md' did not match"), "pathspec '[path]' did not match");
  assert.equal(scrub("cannot open acme/plan.md"), "cannot open [path]");
});

test("links, hosts and addresses are removed", () => {
  assert.equal(scrub("fetch https://user:pw@relay.example.com/v1/mailbox/abc?token=XYZ#frag failed"), "fetch [link] failed");
  assert.equal(scrub("socket wss://relay.example.com/pair?code=123 closed"), "socket [link] closed");
  assert.equal(scrub("connect 52.29.123.45:22 timed out"), "connect [ip] timed out");
  assert.equal(scrub("ssh ec2-52-29-123-45.eu-central-1.compute.amazonaws.com refused"), "ssh [host] refused");
  assert.equal(scrub("clone github.com/julia/secret-client-repo failed"), "clone [path] failed");
  assert.equal(scrub("signed in as julia@example.com"), "signed in as [email]");
});

test("secrets are masked by shape and by the key they follow", () => {
  assert.equal(scrub("bad key sk-ant-api03-abcdefghijklmnopqrstuv"), "bad key [secret]");
  assert.equal(scrub("token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"), "token [secret]");
  assert.equal(scrub(`blob ${"a1B2".repeat(12)} end`), "blob [secret] end");
  assert.equal(scrub("key AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY rejected"), "key [secret] rejected");
  assert.equal(scrub("got 0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp back"), "got [secret] back");
  assert.equal(scrub("relay token 0123456789abcdef0123456789abcdef rejected"), "relay token [secret] rejected");
  assert.equal(scrub("Authorization: Bearer abc.def.ghi"), "Authorization: [secret]");
  assert.equal(scrub("PASSWORD=hunter2"), "PASSWORD=[secret]");
  assert.equal(scrub("glpat-xxxxxxxxxxxxxxxxxxxx is invalid"), "[secret] is invalid");
  assert.equal(scrub("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln expired"), "jwt [secret] expired");
  assert.equal(scrub("chat 1889f7e6-d3c2-4129-916f-64009acfd635 missing"), "chat [id] missing");
});

test("ordinary error text is left readable", () => {
  assert.equal(scrub("TypeError: Cannot read properties of undefined (reading 'id')"), "TypeError: Cannot read properties of undefined (reading 'id')");
  assert.equal(scrub("TypeError: window.consensus.getSettings is not a function"), "TypeError: window.consensus.getSettings is not a function");
  assert.equal(scrub("SyntaxError: Unexpected token < in JSON at position 0"), "SyntaxError: Unexpected token < in JSON at position 0");
  assert.equal(scrub("Invalid token format"), "Invalid token format");
});

test("long text is cut so a quoted prompt cannot travel whole", () => {
  const scrubbed = scrub(`Command failed: ${"please refactor the billing module ".repeat(40)}`);
  assert.equal(scrubbed.length, CRASH_REPORT_MAX_TEXT + 1);
  assert.ok(scrubbed.endsWith("…"));
});

test("an error quoting a huge unbroken token is scrubbed quickly and cut before it", () => {
  for (const blob of ["ab12".repeat(12_500), "a.".repeat(25_000), "x@".repeat(25_000), "a/".repeat(25_000)]) {
    const started = performance.now();
    const scrubbed = scrub(`stderr: ${blob}`);
    assert.ok(performance.now() - started < 200, "scrubbing took too long");
    assert.ok(scrubbed.length <= CRASH_REPORT_MAX_TEXT + 1);
  }
  // A secret split by the scrub window is not sent in part.
  const tail = scrub(`${"word ".repeat(398)}sk-ant-api03-abcdefghijklmnop`);
  assert.ok(!tail.includes("sk-"));
});

test("console and click breadcrumbs are dropped; network breadcrumbs keep no address", () => {
  assert.equal(scrubCrashReportBreadcrumb({ category: "console", message: "prompt: fix my secret repo" }), null);
  assert.equal(scrubCrashReportBreadcrumb({ category: "ui.click", message: "button[aria-label=\"Open chat Taxes 2026\"]" }), null);
  assert.deepEqual(
    scrubCrashReportBreadcrumb({
      category: "electron.net",
      data: { url: "https://api.example.com/v1/x?key=abc", method: "GET", status_code: 500, body: { prompt: "hi" } }
    }, HOME),
    { category: "electron.net", data: { url: "[link]", method: "GET", status_code: 500 } }
  );
});

test("fetch breadcrumbs lose the query string and fragment the SDK keeps apart from the URL", () => {
  assert.deepEqual(
    scrubCrashReportBreadcrumb({
      category: "http",
      data: {
        url: "https://relay.example.com/mailbox",
        "http.method": "GET",
        status_code: 200,
        "http.query": "?mailboxId=ab12&conversationId=1889f7e6",
        "http.fragment": "#x"
      }
    }, HOME),
    { category: "http", data: { url: "[link]", "http.method": "GET", status_code: 200 } }
  );
});

test("integrations that capture typed data or raw memory are excluded by the names the SDK really uses", () => {
  for (const name of [localVariablesIntegration().name, consoleIntegration().name]) {
    assert.ok(CRASH_REPORT_EXCLUDED_INTEGRATIONS.has(name), name);
  }
  const minidump = readFileSync(path.join(process.cwd(), "node_modules/@sentry/electron/main/integrations/sentry-minidump/index.js"), "utf8");
  const minidumpName = minidump.match(/name: '([^']+)'/)?.[1];
  assert.ok(minidumpName && CRASH_REPORT_EXCLUDED_INTEGRATIONS.has(minidumpName), minidumpName);
});

test("an event keeps its shape but loses request data, extra objects and everything about the user except the install id", () => {
  const event = scrubCrashReportEvent({
    message: "failed at /Users/julia/x/y.ts",
    transaction: "/Users/julia/x",
    logentry: { message: "failed %s", params: ["/Users/julia/secret"] },
    exception: { values: [{ type: "Error", value: "open /Users/julia/a/b failed", mechanism: { type: "generic", data: { path: "/Users/julia/z/w" } } }] },
    breadcrumbs: [{ category: "console", message: "x" }, { category: "electron", message: "app.ready" }],
    request: { url: "file:///Users/julia/app/index.html", headers: { "User-Agent": "x" } },
    extra: { unhandledPromiseRejection: true, payload: { prompt: "secret" }, note: "see /Users/julia/n/m" },
    user: { id: "install-1", ip_address: "{{auto}}", email: "julia@example.com" } as { id: string },
    tags: { kept: "yes", url: "https://relay.example.com/x" },
    contexts: {
      os: { name: "macOS", version: "26.6.2" },
      minidump: { crashed_url: "file:///Users/julia/app/index.html" },
      trace: { trace_id: "0123456789abcdef0123456789abcdef" }
    }
  }, HOME);
  assert.equal(event.message, "failed at [path]");
  assert.equal(event.transaction, "[path]");
  assert.deepEqual(event.logentry, { message: "failed %s" });
  assert.deepEqual(event.exception, { values: [{ type: "Error", value: "open [path]", mechanism: { type: "generic", data: { path: "[path]" } } }] });
  assert.deepEqual(event.breadcrumbs, [{ category: "electron", message: "app.ready" }]);
  assert.equal("request" in event, false);
  assert.deepEqual(event.extra, { unhandledPromiseRejection: true, note: "see [path]" });
  assert.deepEqual(event.user, { id: "install-1", geo: {} });
  assert.deepEqual(event.tags, { kept: "yes", url: "[link]" });
  assert.deepEqual(event.contexts, {
    os: { name: "macOS", version: "26.6.2" },
    trace: { trace_id: "0123456789abcdef0123456789abcdef" }
  });
});

test("an error report keeps the app and the system, and nothing about the computer or where it is", () => {
  // What the SDK fills in on macOS (Electron 31, SDK 7.20).
  const event = scrubCrashReportEvent({
    contexts: {
      app: { app_name: "AccordAgents", app_version: "1.12.0", app_arch: "arm64", app_start_time: "2026-11-25T22:39:20.945Z", app_memory: 424951808, free_memory: 531677184 },
      os: { name: "macOS", version: "26.6.2", build: "25G83", kernel_version: "25.6.0" },
      device: { family: "Desktop", arch: "arm64", boot_time: "2026-10-11T10:28:01.362Z", cpu_description: "Apple M4 Pro", memory_size: 25769803776, processor_count: 12, screen_resolution: "3024x1964" },
      gpu: { name: "Apple M4 Pro", vendor_id: "0x106b", active: true },
      culture: { locale: "en-CY", timezone: "Asia/Nicosia" },
      runtime: { name: "Electron", version: "31.7.7" },
      chrome: { name: "Chrome", version: "126.0.6478.234" },
      node: { name: "Node", version: "20.18.0" },
      cloud_resource: {},
      trace: { trace_id: "0123456789abcdef0123456789abcdef", span_id: "0123456789abcdef" }
    },
    user: { id: "install-1", geo: { city: "Nicosia", country_code: "CY" } }
  });
  assert.deepEqual(event.contexts, {
    app: { app_name: "AccordAgents", app_version: "1.12.0" },
    os: { name: "macOS", version: "26.6.2" },
    trace: { trace_id: "0123456789abcdef0123456789abcdef", span_id: "0123456789abcdef" }
  });
  // An empty place, not no place: Sentry looks one up for an event without it.
  assert.deepEqual(event.user, { id: "install-1", geo: {} });
  assert.deepEqual(scrubCrashReportEvent<CrashReportEvent>({ message: "x" }).user, { geo: {} });
});

test("only usage signals leave as logs, with their known attributes only", () => {
  const signal = {
    level: "info",
    message: "provider_first_used",
    attributes: {
      milestone: "provider_first_used",
      install_cohort: "new",
      os: "mac",
      app_version: "1.11.9-beta.1",
      locale: "zh-Hans-CN",
      provider_family: "custom",
      codex_ready: true,
      team_device: true,
      "user.id": "6f1c1a52-6f3b-4d7a-9d55-3f1e0f6f2b10",
      "user.email": "julia@example.com",
      "user.name": "Julia",
      "server.address": "Julias-MacBook-Pro",
      "sentry.release": "AccordAgents@1.11.9-beta.1+mac",
      "sentry.environment": "beta",
      "sentry.sdk.name": "sentry.javascript.electron",
      "sentry.sdk.version": "7.20.0",
      handle: "taylor",
      chat_title: "Acme merger"
    }
  };
  assert.deepEqual(scrubUsageLog(signal), {
    level: "info",
    message: "provider_first_used",
    attributes: {
      milestone: "provider_first_used",
      install_cohort: "new",
      os: "mac",
      app_version: "1.11.9-beta.1",
      locale: "zh-Hans-CN",
      provider_family: "custom",
      codex_ready: true,
      team_device: true,
      "user.id": "6f1c1a52-6f3b-4d7a-9d55-3f1e0f6f2b10",
      "sentry.release": "AccordAgents@1.11.9-beta.1+mac",
      "sentry.environment": "beta",
      "sentry.sdk.name": "sentry.javascript.electron",
      "sentry.sdk.version": "7.20.0"
    }
  });
  // Values outside the known ones are dropped.
  assert.deepEqual(scrubUsageLog({ level: "info", message: "first_chat", attributes: { milestone: "first_chat", locale: "/Users/julia", provider_family: "acme", os: "haiku", app_version: "dev build", team_device: "Julia's MacBook" } })?.attributes, { milestone: "first_chat" });
  // Any other log is dropped whole.
  assert.equal(scrubUsageLog({ level: "info", message: "Sending prompt to @taylor", attributes: {} }), null);
  assert.equal(scrubUsageLog({ level: "error", message: "first_chat", attributes: { milestone: "first_reply" } }), null);
  assert.equal(scrubUsageLog({ level: "info", message: "unknown_step", attributes: { milestone: "unknown_step" } }), null);
});

test("logs about to be sent are checked again, whatever path they took", () => {
  const signal = {
    timestamp: 1794514099.45,
    level: "info",
    body: "first_chat",
    trace_id: "0123456789abcdef0123456789abcdef",
    severity_number: 9,
    attributes: {
      milestone: { value: "first_chat", type: "string" },
      install_cohort: { value: "new", type: "string" },
      os: { value: "mac", type: "string" },
      codex_ready: { value: true, type: "boolean" },
      team_device: { value: false, type: "boolean" },
      "user.id": { value: "6f1c1a52-6f3b-4d7a-9d55-3f1e0f6f2b10", type: "string" },
      "sentry.release": { value: "AccordAgents@1.11.9+mac", type: "string" },
      "sentry.timestamp.sequence": { value: 0, type: "integer" },
      // Set on a scope, or added by the window's SDK: never sent.
      chat_title: { value: "Acme merger", type: "string" },
      "device.model": { value: "MacBookPro18,3", type: "string" },
      "os.name": { value: "macOS", type: "string" }
    }
  };
  const fromWindow = { timestamp: 1, level: "info", body: "Sending prompt to @taylor", attributes: { "device.model": { value: "MacBookPro18,3", type: "string" } } };
  assert.deepEqual(scrubSerializedUsageLogs([signal, fromWindow, null, "x"]), [{
    ...signal,
    attributes: {
      milestone: { value: "first_chat", type: "string" },
      install_cohort: { value: "new", type: "string" },
      os: { value: "mac", type: "string" },
      codex_ready: { value: true, type: "boolean" },
      team_device: { value: false, type: "boolean" },
      "user.id": { value: "6f1c1a52-6f3b-4d7a-9d55-3f1e0f6f2b10", type: "string" },
      "sentry.release": { value: "AccordAgents@1.11.9+mac", type: "string" },
      "sentry.timestamp.sequence": { value: 0, type: "integer" }
    }
  }]);
});

test("a weekly snapshot leaves with its numbers, and a role the person made is never named", () => {
  const base = { milestone: "weekly_snapshot", install_cohort: "existing", os: "mac", app_version: "1.11.9", locale: "en-US" };
  const snapshot = {
    ...base,
    week: "2026-W47",
    members_total: "3-5",
    max_members_in_chat: "2",
    chats_with_2plus_members: "1",
    distinct_roles_in_use: 3,
    custom_roles_count: 2,
    builtin_roles_in_use: "product-designer,software-engineer",
    chats_sessions_view_active: "3-5",
    chats_classic_view_active: "0"
  };
  assert.deepEqual(scrubUsageLog({ level: "info", message: "weekly_snapshot", attributes: snapshot })?.attributes, snapshot);
  const leaking = {
    ...snapshot,
    builtin_roles_in_use: "software-engineer,acme-sales-closer",
    members_total: "7",
    chats_sessions_view_active: 4,
    chats_classic_view_active: "a few",
    distinct_roles_in_use: 2.5,
    custom_roles_count: -1,
    week: "last week",
    role_names: "Acme sales closer"
  };
  assert.deepEqual(scrubUsageLog({ level: "info", message: "weekly_snapshot", attributes: leaking })?.attributes, { ...base, max_members_in_chat: "2", chats_with_2plus_members: "1" });
  assert.deepEqual(scrubSerializedUsageLogs([{ body: "weekly_snapshot", attributes: {
    milestone: { value: "weekly_snapshot", type: "string" },
    custom_roles_count: { value: 2, type: "integer" },
    builtin_roles_in_use: { value: "my-secret-role", type: "string" }
  } }]), [{ body: "weekly_snapshot", attributes: {
    milestone: { value: "weekly_snapshot", type: "string" },
    custom_roles_count: { value: 2, type: "integer" }
  } }]);
});

test("snapshot numbers leave only on a weekly snapshot, and the role list cannot grow or repeat", () => {
  const roles = (value: string) => scrubUsageLog({ level: "info", message: "weekly_snapshot", attributes: { milestone: "weekly_snapshot", builtin_roles_in_use: value } })?.attributes.builtin_roles_in_use;
  assert.equal(roles("debugger,software-engineer"), "debugger,software-engineer");
  assert.equal(roles("software-engineer,debugger"), undefined, "unsorted");
  assert.equal(roles("debugger,debugger"), undefined, "repeated");
  assert.equal(roles(Array(5000).fill("debugger").join(",")), undefined, "too long");
  assert.deepEqual(scrubUsageLog({ level: "info", message: "first_chat", attributes: { milestone: "first_chat", week: "2026-W47", custom_roles_count: 3, builtin_roles_in_use: "debugger" } })?.attributes, { milestone: "first_chat" });
});
