import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { signatureProblems } from "./sign-windows-x64.mjs";

const ours = "8D5B96BC995A35E672E78D459CCBBAB675AD442C";
const microsoft = "F252E794FE438E35ACE6E53762C0A234A2C52135";
const app = path.join("C:", "app-1.2.3");
const exe = path.join(app, "AccordAgents.exe");
const setup = path.join("C:", "AccordAgents-1.2.3-win32-x64-Setup.exe");
const sqlite = path.join(app, "resources", "sqlite", "win32-x64", "sqlite3.exe");
const conpty = path.join(app, "resources", "app.asar.unpacked", "node_modules", "node-pty", "build", "Release", "conpty.dll");
const options = {
  thumbprint: ours,
  ours: [exe, setup],
  keptUnsigned: [path.join("resources", "sqlite", "win32-x64", "sqlite3.exe")]
};
const signed = [
  { path: exe, status: "Valid", thumbprint: ours },
  { path: setup, status: "Valid", thumbprint: ours },
  { path: sqlite, status: "NotSigned", thumbprint: null },
  { path: conpty, status: "Valid", thumbprint: microsoft }
];
const changed = (file, change) => signed.map((entry) => (entry.path === file ? { ...entry, ...change } : entry));

for (const [name, entries, expected] of [
  ["accepts our signature, Microsoft's, and the unsigned SQLite CLI", signed, []],
  // The app refuses to open storage with a signed copy (src/main/services/sqliteCli.ts).
  ["rejects a signed SQLite CLI", changed(sqlite, { status: "Valid", thumbprint: ours }), [/sqlite3\.exe must stay unsigned/]],
  ["rejects a binary the hook failed to sign", changed(conpty, { status: "NotSigned", thumbprint: null }), [/conpty\.dll has no valid signature \(NotSigned\)/]],
  ["rejects a signature that no longer matches the file", changed(exe, { status: "HashMismatch" }), [/AccordAgents\.exe has no valid signature \(HashMismatch\)/]],
  ["rejects an installer signed with another certificate", changed(setup, { thumbprint: microsoft }), [/Setup\.exe is signed by F252.+, not by the release certificate/]],
  ["rejects a missing installer", signed.filter((entry) => entry.path !== setup), [/Setup\.exe is missing/]]
]) {
  test(`Windows signature check ${name}`, () => {
    const problems = signatureProblems(entries, options);
    assert.equal(problems.length, expected.length, problems.join("\n"));
    expected.forEach((pattern, index) => assert.match(problems[index], pattern));
  });
}
