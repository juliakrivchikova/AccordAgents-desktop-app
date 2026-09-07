// Headless probe: does a real CLI actually draw an avatar to spec and save it
// where the studio expects? Runs one or two turns without any UI.
//
// Usage: node scripts/probes/avatar-studio-draw.cjs [--provider claude-code|codex-cli] [--prompt "..."]
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const { CliAgentRunner } = require("../../dist/main/main/services/cliAgents.js");
const { AvatarStudioService } = require("../../dist/main/main/services/avatarStudio.js");

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : fallback;
};

(async () => {
  const provider = arg("provider", "claude-code");
  const prompt = arg("prompt", "нарисуй рыжую лису");
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "avatar-studio-probe-"));
  const service = new AvatarStudioService({
    cliRunner: new CliAgentRunner(),
    workRoot,
    promptRoot: path.join(__dirname, "../../dist/main/main/prompts")
  });
  const studioId = "probe";
  const runner = { kind: provider };
  const started = Date.now();
  const result = await service.runTurn({
    studioId,
    prompt,
    runner,
    member: { handle: "gera", roleLabel: "Software Engineer" }
  });
  console.log(JSON.stringify({
    ok: result.ok,
    error: result.error,
    reply: result.reply?.slice(0, 200),
    mediaType: result.candidate?.mediaType,
    bytes: result.candidate ? Buffer.from(result.candidate.dataUrl.split(",")[1], "base64").length : 0,
    seconds: Math.round((Date.now() - started) / 1000)
  }, null, 2));
  if (result.candidate) {
    const extension = result.candidate.mediaType === "image/png" ? "png" : "svg";
    const out = path.join("/tmp", `avatar-studio-probe.${extension}`);
    fs.writeFileSync(out, Buffer.from(result.candidate.dataUrl.split(",")[1], "base64"));
    console.log("saved", out);
  }
  console.log("workRoot", workRoot);
})().catch((error) => {
  console.error("PROBE ERROR", error.message);
  process.exitCode = 1;
});
