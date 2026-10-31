// Squirrel.Windows compares a prerelease as text once electron-winstaller has
// dropped its dots, so 1.2.3-beta.10 would become "beta10" and sort below
// "beta9": installed apps would keep starting the older version. Padding the
// number keeps betas in numeric order. Windows releases have used this form
// from the first one; an unpadded "beta4" would sort above "beta004", so it
// must not change back.
function squirrelVersion(version) {
  return version.replace(/-([0-9A-Za-z-]+)\.(\d+)$/, (_match, name, number) => `-${name}.${number.padStart(3, "0")}`);
}

// The version electron-winstaller writes into the NuGet package and its file
// name (its convertVersion): the prerelease without dots.
function squirrelPackageVersion(version) {
  const [main, ...prerelease] = squirrelVersion(version).split("+")[0].split("-");
  return prerelease.length > 0 ? `${main}-${prerelease.join("-").replace(/\./g, "")}` : main;
}

module.exports = { squirrelVersion, squirrelPackageVersion };
