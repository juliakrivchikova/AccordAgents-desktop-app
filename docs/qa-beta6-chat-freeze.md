# beta.6 chat responsiveness regression

Verified on macOS arm64, 2026-09-10, against release `a1885f1`.

## Reproduction and cause

The published beta.6 was launched in an isolated profile with an online backup
of the user's 3,698,880,512-byte SQLite database (393 conversations). The large
chat contained 435 messages and about 6.2 MB of message text. Native provider
testing used a separate session fork and a QA member; the live user session was
not resumed. Two synthetic, offline phone pairings reproduced the real profile's
fanout count, with only a loopback relay address and no external mailbox.

`emitReviewProgress` fans each text update out to every phone. Before this fix,
`sendTimelineBatch` asked `listControlCards` to read the entire conversation for
every fragment, even for a disconnected phone. These reads entered the shared
SQLite queue ahead of chat creation, loading and persistence. SQLite output
processing also searched the complete accumulated response for its terminator
on every stdout chunk, making large reads quadratic.

On the unmodified published build, Thinking in the large chat took 12.6 seconds;
after that reply, a new chat had neither Thinking nor a reply after 110 seconds,
with New chat disabled. The provider itself completed the preceding turn in
about 10.6 seconds. This reproduces a database backlog, not provider latency.

## Fix and data path

Transient text no longer reads cards, and disconnected live updates return
before delivery bookkeeping. Conversation snapshots already contain the state
needed for cards and archive filtering, so they no longer trigger extra history
reads. Explicit phone requests and terminal reconciliation still read their
authoritative state. Card-only updates and removal of answered cards are sent
to both live and durable delivery paths.

SQLite buffers response chunks and searches only a bounded suffix for its
terminator. Queries and results still travel over stdin/stdout, never a growing
command-line argument; transaction, error, timeout and restart behavior is
unchanged. The regression test uses a 16 MiB response followed by another queued
query, and checks exact multiline output.

## Real Electron verification

The repaired build used the same copied database and pairings, a production
renderer with its real preload, and real Codex CLI turns. Actions were driven
through the sidebar, composer and New chat/Start chat controls over Electron CDP.

| Scenario | Result |
| --- | --- |
| Open the large existing chat | 630 ms |
| Send in that chat | Thinking 203 ms; final answer 12.2 s |
| New chat immediately after the large reply | Screen 159 ms; Thinking 4.0 s; final answer 12.8 s |
| New chat while the large chat is also running | Screen 156 ms; Thinking 4.4 s; final answer 11.8 s |
| Reopen the large chat after both replies | 311 ms; both replies present; New chat enabled |

Screenshots were saved and visually inspected. This is desktop reproduction
with two offline pairing records; it is not installed-phone QA. Connected relay,
reconnect, card updates, duplicate delivery, cancellation and inactive-pairing
behavior have supporting focused tests.

## Checks and review

- `make typecheck`, `make build`: pass using Node 24.19.0 arm64.
- `mobileRelayControl.test` and `sqliteSession.test`: 42/42 pass.
- `test:storage`: 99/100 pass. The unchanged `deleteConversation removes messages
  and conversation in one transaction` test expects `begin;`, while the existing
  implementation uses `begin immediate;`; the same failure was reproduced on
  unmodified beta.6. Neither that test nor deletion was changed here.
- gstack `/review`: full diff and connected lifecycle reviewed; no unresolved
  findings in this fix. No persistent format or provider permission change.

The user's installed app, live profile and AWS instance were not modified.
