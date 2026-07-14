import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parseSkillFrontmatter, stripOuterMarkdownFence } from "./appSkills";

test("Accord requires durable blind proposals before canonical v1 and signing", async () => {
  const raw = await readFile(path.join(process.cwd(), "src/main/appSkills/accord/SKILL.md"), "utf8");
  const parsed = parseSkillFrontmatter(stripOuterMarkdownFence(raw));
  const body = parsed.body;

  const create = body.indexOf("**Create the collection.**");
  const facilitator = body.indexOf("**Submit your facilitator draft first.**");
  const participants = body.indexOf("**Collect blind participant drafts.**");
  const publish = body.indexOf("**Synthesize and publish v1.**");
  const sign = body.indexOf("**Sign.**");
  assert.ok(create > 0 && create < facilitator);
  assert.ok(facilitator < participants);
  assert.ok(participants < publish);
  assert.ok(publish < sign);

  assert.match(body, /initialState: "collecting_drafts"/);
  assert.match(body, /User can\s+always read every draft/);
  assert.match(body, /peers cannot read one\s+another's drafts/);
  assert.match(body, /must never\s+contain draft content, snippets, readers, or summaries/);
  assert.match(body, /every current required draft as `considered`/);
  assert.match(body, /Draft\s+authorship is provenance, never approval and never a signature/);
  assert.match(body, /accord:<chatThreadRootId>:create/);
  assert.match(body, /assert the\s+normalized audience policy before any participant request/);
  assert.match(body, /selected participant can read another\s+participant's draft/);
  assert.match(body, /assert its actual\s+`effectiveReaders` set/);
  assert.match(body, /Policy intent alone is not\s+sufficient evidence/);
  assert.match(body, /Do not include its content, snippets, readers, summary/);
  assert.doesNotMatch(body, /skip this independent\s+review round/);
});
