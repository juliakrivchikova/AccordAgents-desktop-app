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
  scrubCrashReportText
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
  assert.deepEqual(event.user, { id: "install-1" });
  assert.deepEqual(event.tags, { kept: "yes", url: "[link]" });
  assert.deepEqual(event.contexts, {
    os: { name: "macOS", version: "26.6.2" },
    minidump: { crashed_url: "[link]" },
    trace: { trace_id: "0123456789abcdef0123456789abcdef" }
  });
});
