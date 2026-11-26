const fs = require("fs");
const path = require("path");
const dir = path.join(process.argv[2], "node_modules/@phosphor-icons/react/dist/defs");
const names = process.argv.slice(3);
const out = {};
for (const spec of names) {
  const [name, weight = "regular"] = spec.split(":");
  const src = fs.readFileSync(path.join(dir, `${name}.es.js`), "utf8");
  const start = src.indexOf(`"${weight}"`);
  const end = src.indexOf("]", start);
  const chunk = src.slice(start, end);
  const paths = [...chunk.matchAll(/createElement\("(path|circle|line|rect|polyline)", (\{[^}]*\})/g)].map((m) => {
    const attrs = Function(`return ${m[2]}`)();
    return `<${m[1]} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(" ")}/>`;
  });
  out[weight === "regular" ? name : `${name}_${weight}`] = paths.join("");
}
process.stdout.write(JSON.stringify(out));
