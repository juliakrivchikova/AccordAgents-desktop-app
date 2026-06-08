// aa-data.jsx — sample roster, projects, and a realistic multi-participant conversation.
// All data is fictional product content for the AccordAgents chat workspace mock.

const AV = (name) => `assets/avatars/${name}.png`;

const PARTICIPANTS = {
  you: {
    id: "you", handle: "you", name: "You", kind: "user",
    provider: null, avatar: null, mono: "Y",
  },
  taylor: {
    id: "taylor", handle: "taylor-claude-reviewer", name: "taylor-claude-reviewer",
    kind: "agent", provider: "claude", avatar: AV("claude-bunny"), mono: "T",
    role: "Reviewer", model: "Claude Opus 4.7",
    context: { used: 131000, window: 200000 }, session: "a3f1c08e-44d2-4b71-9c3a-2f5b9d1e7c40",
  },
  drew: {
    id: "drew", handle: "drew-codex-engineer", name: "drew-codex-engineer",
    kind: "agent", provider: "codex", avatar: AV("codex-frog"), mono: "D",
    role: "Engineer", model: "GPT-5.5 Codex",
    context: { used: 74000, window: 272000 }, session: "f5304e8a-cf81-4d93-9836-216756461ed5",
  },
  nova: {
    id: "nova", handle: "nova-gemini-analyst", name: "nova-gemini-analyst",
    kind: "agent", provider: "gemini", avatar: null, mono: "N",
    role: "Analyst", model: "Gemini 3 Pro",
    context: { used: 41000, window: 1000000 }, session: "7be1d2c4-9a08-41ff-8b2e-1c3d5e7f9a0b",
  },
  admin: {
    id: "admin", handle: "admin", name: "admin",
    kind: "agent", provider: "codex", avatar: AV("codex-hamster"), mono: "A",
    role: "Administrator", model: "GPT-5.5 Codex",
    context: { used: 22000, window: 272000 }, session: "0c9a18b7-3e52-4d6a-9f10-77aa21bb34cc",
  },
};

const PROVIDER_LABEL = { claude: "Claude Code", codex: "Codex CLI", gemini: "Gemini" };

// ---- Sidebar projects ----------------------------------------------------
const PROJECTS = [
  {
    id: "accordagents", name: "AccordAgents", open: true,
    chats: [
      { id: "skill-fix", title: "Skill Post-Merge Fix", when: "now", live: true },
      { id: "qa-test", title: "qa test", when: "1m" },
      { id: "obey-ohms", title: "QA Claude obey rule ohms\u2026", when: "12h" },
      { id: "obey-90", title: "QA Claude obey rule 90zdas", when: "12h" },
      { id: "obey-xp", title: "QA obey rule xp842g", when: "13h" },
    ],
    more: 6,
  },
  {
    id: "mctb-all", name: "mctb-all", open: true,
    chats: [
      { id: "chat", title: "Chat", when: "12h" },
      { id: "skill-test", title: "Skill test", when: "12h" },
      { id: "testing-skills", title: "Testing skills", when: "2d" },
    ],
  },
  {
    id: "ai-consensus", name: "ai-consensus", open: false,
    chats: [
      { id: "fx-last", title: "test fx last", when: "3d" },
      { id: "user-avatar", title: "User avatar", when: "3d" },
      { id: "auto-review", title: "Auto-review mode", when: "3d" },
    ],
    more: 3,
  },
];

// ---- Helpers to build message blocks ------------------------------------
const t = (text) => ({ type: "text", text });
const code = (lang, file, body) => ({ type: "code", lang, file, body });
const run = (label, lines) => ({ type: "run", label, lines });

// ---- The active conversation: "Skill Post-Merge Fix" --------------------
const SKILL_FIX_MESSAGES = [
  {
    id: "m1", author: "you", at: "10:42",
    blocks: [t("hi @taylor-claude-reviewer @drew-codex-engineer \u2014 where did we land on the skill-invocation fix? Want to close it out today.")],
  },
  {
    id: "m2", author: "taylor", at: "10:42",
    blocks: [t("Ready to pick up the skill-invocation fix whenever you are \u2014 the approved version stands: inline `/skill-name`, scoped read under #~/.codex/skills + #~/.agents/skills, P2 double-slash. Say the word and I'll start, beginning with P2 + the main-process scoped-read fix.")],
  },
  {
    id: "m3", author: "drew", at: "10:44",
    worked: "1m 57s",
    blocks: [
      t("Ran the app through Electron/CDP and reproduced the skill selection flow. Keyboard and mouse selection both behaved: #/qa stays inline, the textarea keeps focus, and the caret moves to the end."),
      t("Caught one visual artifact: native spellcheck underlines showed through the transparent textarea layer. Fixed it by disabling spellcheck while the inline highlight overlay is active in #src/renderer/components/chat/chat-composer.tsx. `make typecheck` passes and the live CDP check is green."),
    ],
    repoFiles: ["src/renderer/components/chat/chat-composer.tsx"],
    replies: [
      { author: "taylor", at: "10:46", blocks: [t("Diff reads clean. One nit: gate the spellcheck toggle behind `isHighlightActive` so we don't disable it for plain text. Otherwise \u2014 ship.")] },
      { author: "you", at: "10:47", blocks: [t("Agreed. @drew-codex-engineer fold that in and open the PR.")] },
    ],
  },
  {
    id: "m3g", author: "drew", at: "10:47",
    kind: "approval",
    resolvedDefault: "chat",
    approval: {
      who: "drew-codex-engineer",
      grants: [{ label: "repo write", kind: "perm" }],
    },
    blocks: [],
  },
  {
    id: "m4", author: "drew", at: "10:48",
    kind: "approval",
    approval: {
      who: "drew-codex-engineer",
      question: "run the production build before opening the PR?",
      command: "npm run build\n  \u21B3 tsc -p tsconfig.json && vite build --mode production\n  \u21B3 resolves pinned deps from registry.npmjs.org  (web access)\n  \u21B3 writes ./dist  (workspace, already writable)",
      grants: [
        { label: "webAccess", kind: "perm" },
        { label: "npm run build", kind: "shell" },
      ],
      note: "To validate the production build before opening the PR.",
    },
    blocks: [],
  },
  {
    id: "m6", author: "nova", at: "10:49",
    blocks: [t("Worth noting: the scoped-read change touches both #~/.codex/skills and #~/.agents/skills. I'd add a regression test that asserts a skill outside those roots is *not* readable \u2014 cheap insurance against a future path-join bug.")],
  },
  {
    id: "m6c", author: "taylor", at: "10:50",
    kind: "choice",
    answeredDefault: "now",
    choice: {
      title: "Add nova's scoped-read regression test now, or in a follow-up?",
      options: [
        { id: "now", title: "Add it now", desc: "Land the assertion test with this PR so the boundary is locked in.", recommended: true },
        { id: "followup", title: "Follow-up PR", desc: "Open a tracked issue and add the test separately." },
      ],
    },
    blocks: [],
  },
  {
    id: "m7", author: "you", at: "10:51",
    blocks: [t("Good call. @taylor-claude-reviewer do a full review of drew's diff before the PR goes up.")],
  },
  {
    id: "m8", author: "taylor", at: "10:51",
    kind: "choice",
    choice: {
      kicker: "Needs your input",
      title: "How deep should this review go?",
      body: "The diff is small (1 file, ~18 lines) but it touches the composer's focus + caret handling, which has regressed before.",
      options: [
        { id: "full", title: "Full review", desc: "Read the diff, run the composer flow in Electron, check caret/focus edge cases.", recommended: true },
        { id: "quick", title: "Quick pass", desc: "Read the diff only, trust the existing CDP check." },
        { id: "skip", title: "Skip review", desc: "Approve as-is and open the PR now." },
      ],
    },
    blocks: [],
  },
  {
    id: "m9", author: "drew", at: "10:52",
    running: {
      title: "Production build",
      preview: "vite build --mode production \u00b7 bundling 1,284 modules\u2026",
    },
    blocks: [],
  },
];

const EMPTY_CONVO = (title) => ({
  title,
  messages: [
    { id: "e1", author: "you", at: "just now", blocks: [t("This chat is part of the prototype roster but doesn't have scripted content. Open \u201cSkill Post-Merge Fix\u201d to see the full message treatment.")] },
  ],
});

const CONVERSATIONS = {
  "skill-fix": { title: "Skill Post-Merge Fix", messages: SKILL_FIX_MESSAGES, participantIds: ["you", "taylor", "drew", "nova", "admin"] },
};

Object.assign(window, {
  PARTICIPANTS, PROVIDER_LABEL, PROJECTS, CONVERSATIONS, EMPTY_CONVO,
});
