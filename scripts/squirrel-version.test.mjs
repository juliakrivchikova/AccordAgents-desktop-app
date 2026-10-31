import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { convertVersion } = require("electron-winstaller");
const { squirrelPackageVersion, squirrelVersion } = require("./squirrel-version.cjs");

// Squirrel picks the newest installed app the way NuGet orders versions: the
// numbers numerically, a release above its prereleases, prereleases as text.
// With electron-winstaller's conversion alone, beta.10 sorted below beta.9.
test("Squirrel versions sort in release order", () => {
  const releaseOrder = ["1.11.4-beta.2", "1.11.4-beta.9", "1.11.4-beta.10", "1.11.4-beta.100", "1.11.4", "1.11.5-beta.1"];
  const converted = releaseOrder.map((version) => convertVersion(squirrelVersion(version)));
  for (let index = 1; index < converted.length; index += 1) {
    const [olderMain, olderPre = ""] = converted[index - 1].split("-");
    const [newerMain, newerPre = ""] = converted[index].split("-");
    const ordered = olderMain !== newerMain
      ? olderMain.localeCompare(newerMain, "en", { numeric: true }) < 0
      : (olderPre !== "" && newerPre === "") || (olderPre !== "" && olderPre < newerPre);
    assert.ok(ordered, `${converted[index - 1]} should sort below ${converted[index]}`);
  }
});

test("the package version is electron-winstaller's conversion of the Squirrel version", () => {
  for (const version of ["1.11.4-beta.3", "1.11.4-beta.10", "1.12.0", "2.0.0-beta.123"]) {
    assert.equal(squirrelPackageVersion(version), convertVersion(squirrelVersion(version)));
  }
  assert.equal(squirrelPackageVersion("1.11.4-beta.3"), "1.11.4-beta003");
  assert.equal(squirrelPackageVersion("1.12.0"), "1.12.0");
});
