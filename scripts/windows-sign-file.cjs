// Signs one Windows file for @electron/windows-sign, which calls it for every
// file of the app and again for the Squirrel installer. The certificate is the
// one whose thumbprint is in WINDOWS_SIGN_CERT_SHA1 (sign-windows-x64.mjs sets
// it from package.json config.windowsSignCertSha1); its key stays in Certum's
// cloud and signtool reaches it through SimplySign Desktop. windows-sign only
// logs a failed hook, so a file that could not be signed is also listed in
// WINDOWS_SIGN_FAILURES, which sign-windows-x64.mjs reads afterwards.
const { appendFileSync } = require("node:fs");
const { execFileSync, spawnSync } = require("node:child_process");
const path = require("node:path");

const signtool = process.env.WINDOWS_SIGNTOOL_PATH
  || path.resolve(__dirname, "..", "node_modules", "@electron", "windows-sign", "vendor", "signtool.exe");

// The app checks the bundled SQLite CLI byte for byte before it opens storage
// (src/main/services/sqliteCli.ts), so a signature would stop it from starting.
const keptUnsigned = [path.join("resources", "sqlite", "win32-x64", "sqlite3.exe")];
const attempts = 3;

function hasValidSignature(file) {
  return spawnSync(signtool, ["verify", "/pa", "/q", file], { stdio: "ignore" }).status === 0;
}

function sign(file) {
  execFileSync(signtool, [
    "sign",
    "/sha1", process.env.WINDOWS_SIGN_CERT_SHA1,
    "/fd", "sha256",
    "/tr", "http://time.certum.pl",
    "/td", "sha256",
    "/d", "AccordAgents",
    file
  ], { stdio: "inherit" });
}

function signWindowsFile(file) {
  if (keptUnsigned.some((suffix) => file.endsWith(suffix))) {
    return;
  }
  // Files that arrive signed by their own publisher (Microsoft's ConPTY and
  // d3dcompiler) keep that signature.
  if (hasValidSignature(file)) {
    return;
  }
  // The timestamp server and the SimplySign connection fail now and then.
  for (let attempt = 1; ; attempt += 1) {
    try {
      sign(file);
      return;
    } catch (error) {
      if (attempt === attempts) {
        if (process.env.WINDOWS_SIGN_FAILURES) {
          appendFileSync(process.env.WINDOWS_SIGN_FAILURES, `${file}\n`);
        }
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_000);
    }
  }
}

module.exports = signWindowsFile;
module.exports.keptUnsigned = keptUnsigned;
