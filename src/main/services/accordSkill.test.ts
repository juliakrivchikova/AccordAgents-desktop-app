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

test("Accord treats a signature with document-directed findings as a correction, not completion", async () => {
  const raw = await readFile(path.join(process.cwd(), "src/main/appSkills/accord/SKILL.md"), "utf8");
  const parsed = parseSkillFrontmatter(stripOuterMarkdownFence(raw));
  const body = parsed.body;

  // Core rule: a signature means correct and complete with no changes
  // requested; signing while requesting changes is the signer's violation.
  assert.match(body, /A signature is the signer's binding statement that the resolution is correct and\s+complete and that they request no changes/);
  assert.match(body, /Signing while\s+requesting any change is a protocol violation by the signer/);
  // Verify step: requested changes block completion regardless of signatures.
  assert.match(body, /if any reply requests changes to\s+the resolution's text/);
  assert.match(body, /the\s+round is not complete regardless of signatures/);
  assert.match(body, /no\s+reply from its sign round requested changes/);
  // Approval prompt: three explicit outcomes with the litmus test, and the
  // reviewer must enumerate before deciding.
  assert.match(body, /Answer three questions explicitly in your reply before deciding/);
  assert.match(body, /- Approve — all three answers are clean: sign the current version\./);
  assert.match(body, /- Amend — something belongs in the document: do not sign/);
  assert.match(body, /- Dispute — a commitment or disposition is wrong: do not sign/);
  assert.match(body, /Sign only if you request no changes: a signature states the resolution is correct\s+and complete/);
  // Findings are artifact content, not chat content.
  assert.match(body, /Review findings follow the same rule as drafts: they live in the artifact, never\s+only in chat/);
  assert.match(body, /A finding that\s+exists only in a chat reply is an unfinished round/);
});
