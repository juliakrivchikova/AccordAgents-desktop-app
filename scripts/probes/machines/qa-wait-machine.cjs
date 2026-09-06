const path = require("path");
const { attach } = require(path.resolve(process.argv[2], "scripts/cdp.cjs"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const client = await attach({ port: 9223 });
  for (let i = 0; i < 40; i += 1) {
    const r = await client.evaluate(`(async () => JSON.stringify(await window.consensus.listMachines()))()`, { awaitPromise: true }, { timeoutMs: 10000 });
    const list = JSON.parse(r.result.value);
    const status = list.status[0];
    if (status?.connected) { console.log("connected after", i, "s:", JSON.stringify(status)); process.exit(0); }
    await sleep(1000);
  }
  console.log("machine did not connect in 40s"); process.exit(1);
})().catch((e) => { console.error(e); process.exit(2); });
