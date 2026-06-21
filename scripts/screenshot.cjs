const { attach } = require("./cdp.cjs");
const fs = require("node:fs");
const path = require("node:path");

(async () => {
  const { screenshot, close } = await attach();
  const outDir = path.join(__dirname, "..", "screenshots");
  fs.mkdirSync(outDir, { recursive: true });
  const name = process.argv[2] || "desktop.png";
  const out = path.join(outDir, name);
  const shot = await screenshot();
  fs.writeFileSync(out, shot.data);
  console.log(out);
  close();
})();
