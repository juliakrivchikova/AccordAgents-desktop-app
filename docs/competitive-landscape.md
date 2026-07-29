# Competitive landscape: Buzz and Codor

Snapshot of the two closest neighbors to AccordAgents, with a capability comparison and a
borrow list. Facts below come from reading their actual sources, not press coverage.

Last reviewed: **2026-07-26**. Buzz inspected at commit `a31fc4d`; Codor at v0.10.4
(repo created 2026-07-19). Both projects are young and moving fast — re-verify before
building against anything here.

---

## Buzz (Block / Jack Dorsey)

**GitHub:** <https://github.com/block/buzz> · Apache-2.0 · Rust + TypeScript · launched 2026-07-21

Multi-human team workspace ("Slack + GitHub replacement") where AI agents are first-class
channel members. Built on Nostr: every message is a signed event passed through
store-and-forward relays, so identity and audit live in the protocol, not a vendor DB.
Agents get their own keypair; the owner signs a scoped attestation (NIP-OA) authorizing
them, and their work is signed under their own identity — revocable without touching the
owner. Buzz does **not** run agents: they run externally on any harness (goose, Codex,
Claude Code) and attach via Agent Client Protocol through the `buzz-acp` harness, talking
to the relay over WS + REST like a human client. Self-hosting means running the Rust relay
plus PostgreSQL, Redis, and MinIO. Git hosting, YAML workflows, and workflow approval
gates are roadmap, not shipped. Their own framing: early stages.

The part worth studying is `crates/buzz-acp`: it assembles a disciplined per-turn prompt
(`[Base]` platform briefing → `[System]` owner prompt → `[Team Instructions]` → auto-injected
core memory → `[Context]` scope/reply-anchor → thread context with named authors →
triggering `[Event]`), and `base_prompt.md` is the best multi-agent chat etiquette manual
we have seen (see borrow list).

Press: [TechCrunch](https://techcrunch.com/2026/07/21/jack-dorsey-is-taking-on-slack-with-buzz-a-group-chat-platform-for-teams-and-their-ai-agents/) ·
[SiliconANGLE](https://siliconangle.com/2026/07/21/block-launches-buzz-open-source-workspace-humans-ai-agents/)

## Codor (rjx18 / "richhard")

**Reddit (origin post):** <https://www.reddit.com/r/codex/comments/1v0nav6/fable_56_sol_opus_on_the_same_team_is_just_unfair/>
· **GitHub:** <https://github.com/rjx18/codor> · [Discord](https://discord.gg/PtUfM6BhBy) · MIT · TypeScript · alpha v0.10.4, ~234 stars in week one

Local-first "switchboard" born from the viral r/codex post about running Fable + GPT-5.6
Sol + Opus as one team. A single Node daemon per machine (Fastify + ws, better-sqlite3 +
JSONL run blobs) owns the message store, a pure mention router, and an adapter host that
**spawns, supervises, and resumes** harness sessions — same layer we occupy. Client is an
installable React PWA served by the daemon (phone access via Tailscale; separate
closed-source iPhone/Watch apps). Adapters: Claude Code (Agent SDK `query()`), Codex
(persistent `codex app-server` JSON-RPC), plus Cursor, Gemini/Antigravity, Copilot,
OpenCode. Drives already-authenticated CLIs, so Claude Max / GPT Plus subscriptions work
with no API keys. Distinctive design: the router fans a byte-identical payload out to each
mentioned member (only a `you=@handle` field differs), and **each agent only ever sees
messages it was addressed in** — the human sees everything. Accountless E2EE identity via
device Ed25519 keypairs + QR pairing. Solo/single-box today; multi-human orgs and
multi-box residency are schema-present but unenforced (roadmap M2/M5).

Note: `codor.dev` ("local-first DevOps agent" over OpenRouter) is an unrelated older
project or name collision — the repo contains no reference to it.

---

## Capability comparison

| Capability | AccordAgents | Buzz (Block) | Codor |
|---|---|---|---|
| Topology | One human + agents, local Electron app; Cloud Runs for remote workers | Multi-human decentralized team network (Nostr relays); self-host = relay + Postgres + Redis + MinIO | One human + agents, local daemon + PWA; multi-human/multi-box schema-present, unenforced |
| Agents as chat members | Yes — participants with handles, roles, behavior rules | Yes — own keypair, channel membership "like a teammate" | Yes — `Member{kind:'agent'}` with `@handle`, purpose, policy |
| Harnesses / models | Claude Code, Codex, Gemini (`agy`); HTTP APIs (OpenAI, Anthropic, Gemini) | Any ACP agent: goose, Codex, Claude Code; model-agnostic | Claude Code (SDK), Codex (app-server), Cursor, Gemini/agy, Copilot, OpenCode; ACP slot |
| Runs + supervises the CLIs | **Yes** — spawn, 15-min timeout, SIGTERM→SIGKILL, ref-counted cancel, interrupted-run recovery, debug JSONL | **No** — agents run externally, attach via `buzz-acp` over WS/REST | **Yes** — adapter host spawns/attaches/resumes; crash → member `dead` + system msg; stall polls |
| Subscription CLI auth (no API keys) | Yes — drives locally authed CLIs; per-machine device auth for remote | N/A — auth belongs to whatever harness you run | Yes — explicit design goal ("login = subscription auth") |
| Agent→agent triggering | @mention **gated by human approval** (`ChatPendingMention`) | Ordinary mentions, ungated; approval gates on roadmap ("glue still drying") | @mention in a reply auto-invokes; ungated by default |
| Human approval gates | Mention approvals + app-tool approvals + permission change requests | 🚧 not shipped; scoping is identity-level, "not permission flags" | Claude only: `canUseTool` → ask cards (once/always/deny); others rely on spawn-time sandbox |
| Autonomous-chain limits | Human approval per mention | None shipped | **Brakes**: consecutive-hop `turn_brake` + daily `spend_brake_usd` hold next delivery |
| Per-agent context visibility | Shared timeline; participants get full chat context | Full channel feed for member channels | **Mention-scoped**: agent sees only messages addressed to it + opt-in `#N` refs; human sees all |
| Prompt enrichment | Role configs + behavior rules + per-turn app context injection | `[Base]` etiquette manual + `[System]` + `[Team Instructions]` + core memory + `[Context]` reply anchor + named-author thread context | Structured delivery header (`from/to/you`), inlined `#N`/`[[ledger]]` blocks, first-delivery `[roster]` + `[conventions]` trailer |
| Session persistence / resume | Per-participant `sessionId`s resumed across turns and app restarts | Harness's problem; `buzz-acp` keys sessions per channel | `session_ref` durable identity; resumes across turns, daemon restarts, crashes; TUI↔daemon custody transfer |
| Compaction / memory | Participant compaction (Codex compact protocol, token-usage triggers) | Agent-side; auto-injected `core` memory (65 KB cap discipline, cold `mem/` slugs), fail-open fetch | Engine-native compaction (Claude `/compact`, Codex notifications); shared Obsidian-style `[[ledger]]` vault per channel |
| Sandboxing enforcement | **Enforced at spawn**: `--sandbox read-only`, `--cd`, ephemeral mode; per-run grants | None venue-side; identity-scoped trust | Policy → native sandbox mapping (read-only/workspace-write/full); agents structurally can't raise own permissions; **no OS sandbox** |
| Git | Repo selection, `GitDiffMode` diffs, repo-file mentions, review flows; no hosting | `buzz repos`/`buzz pr` CLI; PRs link back to channels; **hosting backend not yet built** | None managed — per-agent `cwd` may point at a worktree; diffs only as tool-output rows |
| Remote / mobile | Cloud Runs (EC2 workers); no mobile client | Desktop mac/win/linux; mobile app in tree; admin-web | PWA on phone via Tailscale; closed-source iPhone/Watch apps; push relay (VAPID/APNs) |
| Usage / cost tracking | Token usage for compaction thresholds; no cost meter | Turn usage metrics published by harness (`usage.rs`) | Per-turn USD estimate, per-member/day meter + budgets, account-limits probe every 5 min |
| Attachments / artifacts | Chat attachments + artifact system (drafts, rosters, revisions, signing, publish, access control) | Canvases + frame-anchored comments; signed-event audit log | Attachments (25 MB, 8/msg, orphan-swept); produced-artifact snapshots; ledger vault |
| Identity / auth | Local single-user app; OS keychain (`safeStorage`) for API keys | Nostr keypairs, NIP-OA owner attestation, sibling-agent detection, revocation | Device Ed25519 + QR pairing, sealed-box E2EE, hashed per-member socket tokens |
| License / maturity | Private; shipping product surface | Apache-2.0; launched 2026-07-21, self-described early stages | MIT; alpha v0.10.4, one week old |

Where each is strongest: **AccordAgents** — enforced human-in-the-loop gates, spawn-time
sandboxing, artifact/decision workflow, interrupted-run recovery. **Buzz** — identity and
audit (portable, cryptographic, revocable), multi-human topology, prompt/etiquette
engineering. **Codor** — context economy (mention-scoped delivery), breadth of adapters,
mid-turn steering, cost governance, mobile reach.

---

## What we want to borrow

### From Buzz (`crates/buzz-acp`)

1. **The etiquette pack in `base_prompt.md`.** Callback-mention MUST-rule ("when you finish
   delegated work you MUST @mention the delegator" — "the #1 cause of stalled
   collaboration"), the bare-acknowledgement ban with a banned-phrase list ("Got it",
   "Standing by"…), narrative-vs-action mention hygiene (naming ≠ pinging), "address people
   by the name in their own message header", "praise in public; correct in the work".
   → Fold into our default role presets / `chatBehaviorRules` (`settings.ts`,
   `docs/chat-roles-and-participants.md`).
2. **Explicit reply-anchor in a structured `[Context]` block**, with different threading
   policy for human-facing turns (keep flat) vs agent-only subthreads (nesting allowed)
   (`queue.rs` `format_context_hints`). → Our injected per-turn context in `chat.ts` could
   carry an explicit reply destination instead of leaving it implicit.
3. **Auto-injected core memory with size discipline** — small always-on `core`, cold
   `mem/<topic>` slugs read on demand, evict-on-ship, and fail-open fetch semantics that
   never mistake "storage unreachable" for "no memory" (`pool.rs`, `engram_fetch.rs`).
   → Model for per-participant durable memory beyond CLI sessions.
4. **Subscription-rule wake filters** — ordered boolean expressions over
   author/content/kind/channel with eval timeouts, first match wins (`filter.rs`).
   → Lightweight per-participant "when do I wake" config alongside mention approvals.
5. **Presence reactions with guaranteed cleanup** — 👀 on pickup, 💬 while replying,
   RAII-style removal on every exit path including panics (`ReactionGuard`, `pool.rs`).
   → UX affordance for our per-message run state; the guard pattern also applies to our
   run-state bookkeeping.
6. **Conversational agent creation as owner-reviewed drafts** — `buzz agents draft-create`
   opens a draft the owner must review/save in the desktop app; chat can propose teammates
   but never mint them (`base_prompt.md`). → Same shape as our participant approval flows;
   would let chat agents propose new participant configs safely.

### From Codor (`packages/switchboard`, `packages/adapters`)

1. **Mention-scoped delivery.** Fan out a byte-identical payload per recipient (only
   `you=@handle` differs); agents see only what they're addressed in, widen via explicit
   `#N` references; the human sees everything (`router.ts`). → Big token savings and less
   cross-talk; worth offering as a per-participant context mode versus our full-timeline
   injection.
2. **Conventions trailer, sent once.** The room's interaction contract (`@` auto-invokes,
   plain name = discuss-only, `#N` refs, `<ACK_OK>` no-op) is injected only on first
   delivery and after a mis-address, not every turn (`router.ts` `composeDeliveryBriefing`).
   → Cheaper than re-sending etiquette every turn.
3. **Mid-turn steering.** New mentions for an already-running agent are injected into the
   live turn (Claude `PostToolUse` hook draining an inbox; adapters may expose `steer()`)
   instead of queuing a new turn (`claude-code/adapter.ts`, `daemon.ts`). → Directly
   relevant to `participantTurnQueues` — lets a peer interject without waiting out a turn.
4. **`post --wait` blocking consult.** An agent posts `@peer …` and blocks inside its own
   turn until the addressed member replies, bounded by timeout (`collaboration.ts`).
   → Natural upgrade for our participant-request threads.
5. **Brakes on autonomous chains.** Pure `evaluateBrakes()` holds the next agent→agent
   delivery when consecutive hops or today's spend cross per-channel thresholds
   (`router.ts`). → Complements our approval gates: approvals for sensitive steps, brakes
   for runaway loops and budget.
6. **Cost governance.** Per-turn token→USD from a static rate table, per-member/day meters
   and budgets, plus a 5-minute background probe of account rate-limit status
   (`pricing.ts`, `limits-probe.ts`). → We track tokens for compaction only; spend chips and
   a limits probe would surface subscription health in the UI.
7. **"Agent can never raise its own permission" as a structural invariant** — the agent
   capability set simply omits `configure`/`spawn`/`kill` (`authorization.ts`). → We enforce
   this via approval flows; worth asserting structurally in the app-tool surface too.
8. **JSONL run blobs beside SQLite.** Event streams live in one JSONL blob per run message
   (`events_ref`), keeping the DB small and enabling merge-by-journal-index for late-joining
   viewers (`blobs.ts`). → Our debug logs are close; the referenced-blob scheme would slim
   `conversation_messages` for long runs.

### Explicit non-goals (for now)

- Nostr/decentralized identity and relays (Buzz) — wrong trade-off for a single-user local
  cockpit; revisit only if multi-human sharing becomes a goal.
- Git hosting (Buzz roadmap) — we integrate with existing repos on purpose.
- Dropping venue-side enforcement in favor of identity-scoped trust — enforced sandboxing
  and approvals are our differentiator; both neighbors are weaker here.
