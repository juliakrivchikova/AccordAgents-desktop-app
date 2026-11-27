# Members' long-term memory

Members keep notes for themselves and each other across chats, sessions,
providers and machines. The User never has to think about it: members decide
what to write, find it, update it and archive it on their own, and never
mention memory to the User unless she asks. Settings → Memory only lets her
look at notes and delete one.

Decided by the User on 2026-11-04 (chat design "Память участников — план v1").

## What a note is

- **Kinds:** `runbook` (how to do a task well next time), `article` (knowledge
  the code does not show: decisions and why, limits of outside systems, the
  User's preferences tagged `preference`), `status` (one task: where the member
  stopped, branch, what is done and released, what is open or awaited).
  A daily diary is deliberately not a kind: the chat already keeps the history,
  a task status is what a member needs to continue.
- **Scopes:** `global` (every member), `project` (chats of the same project
  folder), `role` (members of the same role), `chat` (one chat). A status is
  never global.
- **Filed under another project** (the User, 2026-11-27): a project note is
  the chat's project unless the member names another with `project` (its
  folder's name, any case, or its path). Only the User's projects count: the
  folders of her chats on the server; a name she has not is refused with the
  list of hers, a name two of hers share asks for the path. Such a note is
  seen in that project's chats only, not in the chat that wrote it, so a
  member who worked on one project from another chat (or one with no
  project) keeps what it learned there instead of making it global. A note
  moves the same way (a change with scope `project` and `project`); a retry
  of a move whose answer was lost is answered as done though the member no
  longer sees the note. Members are told (tool description and
  `MEMBER_MEMORY_INSTRUCTIONS`) that knowledge about one project is never
  global. A server older than the app ignores `project` and keeps the note
  under the chat's project; the tool says so.
- Title, Markdown body (16 KB at most), up to 12 tags, optional source, author,
  last writer, version, created / updated / last confirmed, archived.

## Where knowledge goes, in order

Decided by the User on 2026-11-27; members are told it in this order
(`MEMBER_MEMORY_INSTRUCTIONS`):

1. **The repository.** Everything about the code, its architecture and how
   the project is worked on (the parity rules included) goes into the
   repository's docs, CLAUDE.md or AGENTS.md, as part of the member's current
   task (its branch and changes), so other developers and agents working
   without AccordAgents see it. With no task to carry the change, the member
   keeps it as a project note marked `awaitingRepository` and moves it into
   the repository with the next task in that project, then archives the note.
2. **AccordAgents memory, for everything else:** the User's preferences and
   corrections (articles tagged `preference`), User-specific or private
   details and anything not for a public repository (a member treats a
   repository as public unless it checked it is private), task statuses,
   outside systems. It is the primary memory members share: they write
   shared knowledge here first (on 2026-11-26 the main session had kept the
   User's preferences only in Claude Code's memory files, which only that
   CLI on that computer reads, so members on other providers and on cloud
   machines never saw them).
3. **A CLI's own memory is never touched** (the User, 2026-11-27): whatever
   Claude Code or Codex keeps in its own memory stays exactly as the CLI
   keeps it, so working with the CLI directly is as before. Members are not
   told to stop using or to clean it; the app copies it into members' memory
   read-only (a separate sync, which files each copy under the project its
   CLI folder belongs to with `project`, below).

## Where it lives and who sees what

Notes live on the User's own server (`src/hub/hubMemory.ts`, table
`member_memory_notes`). A member on this computer and a
member on a cloud machine reach the same notes the same way (parity
requirement 1). Every request names the chat and the member; the server checks
against its own copy of that chat that the member is in it and runs on the
device that asks, and takes the member's role and project from the chat, never
from what the member says (a member may file a note under another of the
User's projects, above, but sees only its chat's). The phone has no access; Settings uses owner-only
actions (`list`, `owner-read`, `delete`).

### Moving to another server

Notes move with the chats (the User, 2026-11-04). The computer that set up the
server keeps a copy of every note (`src/main/services/memoryMirror.ts`, table
`member_memory_mirror` in its own database): about every minute it reads what
changed on the server in the order of changes (owner-only `export`). The first
time it links to a server (moving from the one inside the app to her own, or
setting hers up again), it puts the copy there (owner-only `import`), each note
as it was — id, version, author, dates, archived or not — where that server has
no note of that id; once per server. Until it is there, members' memory on
that server waits ("memory is moving"), so nobody writes a note beside one
about to arrive. The order of changes only goes up and a deletion keeps its
place, so the copy learns of every change and every deletion; a note the User
deletes in Settings is marked deleted in the copy before the server is asked,
so a lost answer never brings it back. When the link to a server ends (a move
starts), the copy reads it one last time (up to 5 s); changes the copy could
not read before the old server went away are not moved.

Signed requests go to `/v3/memory`: reads as `GET ?request=<json>`, changes as
`POST`. A server older than the app answers 404 and members are told memory is
not there yet.

## How members use it

- App MCP tools `app_memory_search`, `app_memory_tags`, `app_memory_read`,
  `app_memory_write`, `app_memory_archive` (`src/shared/appMcpToolContracts/memoryTools.ts`),
  available to every member and auto-approved like documents.
  `app_memory_tags` lists the tags in use on the notes the member sees, most
  used first, so a new note takes a tag already in use instead of a new
  spelling of it (members are told to reuse tags).
- The way to keep memory is part of every member's static instructions
  (`MEMBER_MEMORY_INSTRUCTIONS` in `chat/`).
- A session's first turn, a turn that sends the instructions again, and the
  first turn after a compaction carry the list of every note the member sees,
  one short line each: kind, title, scope and id (the User, 2026-11-27,
  instead of the 25 most relevant). The chat's own notes come first (the
  member's open statuses, then project notes waiting for the repository, then
  the rest of its project's, role's and chat's notes by activity), the global
  ones after; then a line with the most used tags (up to 12). Past 150 notes
  the list keeps all of the chat's own (up to 300) and the global ones most
  relevant to the chat: closest in meaning to the chat's title and the
  message the session starts with, when the server searches by meaning (else
  the most recently active), and says how many are left out and that
  `app_memory_search` finds them. The list is at most 32 KB (UTF-8; a
  Gemini member gets its message as one command-line argument, 128 KB at
  most on Linux); what does not fit is counted as left out. The list carrying a message goes as a POST
  (any server takes any memory action as POST). The app asks for it with
  `full`; an app older than the server (a machine runtime not upgraded yet)
  asks without it and gets the list it knows: the 25 most relevant, or none
  while notes are picked for each message. Bodies are read with
  `app_memory_read`, which says who wrote the note and that it is reference,
  not the User's instructions.
- A list or tool call the server could not answer says so and never reads as
  "no memory". The list waits at most 4 s before the turn starts without it.
- With search by meaning on (below), each turn also carries the few notes
  picked for its message (the first turn too, after the list); later turns
  carry only those. A note in the list is not counted as given: a pick can
  still bring it when a message needs it. An older server leaves the list
  out while it picks and says so (`picks` with no notes): the session is then
  told that notes come with each message, and the rest of this item holds
  for it. The server answers with picks only while it can pick (the key
  works, every note is printed, OpenAI answers); a pick it cannot make says
  `enabled: false`, and the app then stops asking for a minute and gives a
  session told that notes come with each message the list in that same turn
  (or, when the server did not answer at all, with its next one). What a
  session was told is kept with it (`ChatParticipantSession.memoryNotesPicked`),
  so an app restart does not forget it; a session given the list is not
  marked.
- `app_chat_search` finds messages in the other chats of the member's project
  (a chat with no project searches the other chats with no project; the
  User, 2026-11-26: "в других чатах этого проекта"; the member's own chat is
  in its context): by any word asked, in any form, best match first, always
  (the chats' word index, `ChatSearchService` with `anyWord`, `repoPath` and
  `excludeConversationId`), and by meaning when it is on, the two taking
  turns. With neither answering it says so rather than finding nothing. It returns the chat's title, the author, the time and the
  passage, never whole messages. It goes through the memory route, so the
  server checks the member as for memory.

## Search by words (without a key)

`app_memory_search` with `query` (`src/hub/memoryWordSearch.ts`), decided by
the User on 2026-11-26 (chat document "Поиск по смыслу: память, чаты,
инструкции"): memory must get as much better as it can without a model.

- A note is found when it has **any** of the words asked, not all of them.
- A word counts in its other forms, the same rule for every language: a
  word of 3–4 letters finds the words it starts ("test" → "tests", "ключ" →
  "ключи"); words whose shorter one has 5 letters share the first 4 ("ветка"
  → "ветку"); longer ones the first 5 ("deploy" → "deployment"). Two-letter
  words match only themselves; one-letter words are left out. A word of 5
  letters or more found inside a longer word ("session" in "sqliteSession")
  counts half. In scripts written without spaces (Chinese, Japanese, Thai…)
  a word is found anywhere, as before. Letters keep their marks (Hindi vowel
  signs). A query with no word left keeps the old rule.
- Notes are ranked by BM25, a match in the title weighing three times and in
  a tag twice; equal scores go most recently active first. A note holding
  only words more than half of the notes hold ("на", "the") is left out,
  unless every word asked is such a word. At most 32 different words count.
- Each note found comes with `snippet`: the passage of its body (at most 220
  characters, "…" included, never half a character) where most of the words
  asked are close together, or the body's start when only the title or a tag
  matched. The answer carries `ranking: "any-word"`.
- An older server (it updates itself soon after the app) finds only notes
  holding every word; an empty answer from it to several words tells the
  member to search one word at a time.
- Members are told (tool description and `MEMBER_MEMORY_INSTRUCTIONS`) to ask
  with several words at once: synonyms and translations into the languages
  the notes are written in. The model is the member itself.
- Cost: candidates are the notes holding the first letters of a word asked
  (two-letter words only when nothing longer is asked); their search text is
  read and counted 50 notes at a time, bodies only for the notes returned. On
  the User's notes it is instant; at the server's limit (2000 notes of 16 KB
  where every word matches) counting takes about a second on a Mac.
- Measured on the User's 59 notes with 37 queries written for them (23 of
  them in another language than the notes): the right note in the first
  five for 35% of the queries as asked (3% with the old rule), and 100% when
  asked as members are told to (by taylor, who knows the notes: an upper
  bound). Settings → Memory's search box keeps the old rule: it is a filter.

## Search by meaning (with the User's OpenAI key)

Decided by the User on 2026-11-26 (same chat document): OpenAI
`text-embedding-3-small`, her key, for her chats only.

- The key is entered in Settings → General ("Search by meaning"). It goes to
  her server and stays there (`hub_documents` "semantic-search", like the
  Telegram token for alerts): the server searches, so the server holds it.
  It is checked with one request before it is kept; Settings shows only that a
  key is entered, how much is printed, and why OpenAI stopped taking it. The
  key is sent only as POST (`MEMORY_POST_ONLY_ACTIONS`), never in an address.
- The server (`src/hub/semantic/`) keeps a print of every memory note not
  archived and every message shown in a chat (the User's, and members'
  finished replies). Long text is cut into passages (notes 1200 characters,
  messages 1500, at most 8 per message), each printed. Notes keep the whole
  print (1536 numbers), messages the first 512; one signed byte per number.
  A message is printed as the chat shows it (`printableText`: what the chat
  hides is not found; a member's posts during its turn are, with its reply)
  and read again when found. Prints are kept in `semantic_prints` and read
  into memory once, side by side in big blocks (`PrintArena`): on the User's
  ~21 thousand messages about 15 MB of the server's memory, let go when the
  key is removed or refused.
- New notes and messages are printed as they come (1.5 s after, in batches);
  the old ones once, in the background, a page at a time, with a pause
  between requests. A restart prints only what changed (a hash of the text).
  A message hidden or removed, or a chat deleted, is forgotten at once (even
  while it is being printed); a chat moved to the server is printed from the
  database a page at a time once it arrives. A key removed or changed stops
  the work done for the old one at once (its requests and waits are called
  off). The whole pass over the User's ~22 thousand messages reads 220 pages
  of at most about 170 KB (about 3 s of reading on her Mac, 2026-11-26). Prints of anything else gone are forgotten at the end of that pass
  (only what was printed before it began). A pass the database failed is
  tried again, later and later, while the key stays the same.
- `app_memory_search`: the closest in meaning (closer than 0.15) and the best
  by the words asked take turns, meaning first; `ranking: "meaning"`. On her
  notes, meaning first then words put the right note in the first five for
  82% of queries naming an id or a class; taking turns for all of them,
  keeping the first place of every query asked by meaning (sums of scores and
  reciprocal ranks lost it for a third). The passage is the closest one, cut
  around the words asked.
- The chat's own notes first (the User, 2026-11-27; `src/hub/memoryRanking.ts`):
  at similar relevance a note of the chat's project, the member's role or the
  chat comes before a global one, in both rankings and in picks: by meaning a
  global note must be more than 0.03 closer, by words score more than 1.5
  times as much. A global note that fits clearly better still leads; a pick
  still needs 0.40 by itself. Measured on her 113 notes with 79 queries
  (`~/reference/memory-search-eval/scripts/project.mjs`): "выпуск беты через
  GitHub Actions" asked from an AccordAgents chat put another project's
  global runbook first; now this project's note is first and that runbook is
  out of the first three. Over 12 such queries the right note came first for
  83% (75% before) and another project's note was in the first three for
  17% (42%); 12 queries a global preference must win, the queries asked from
  another project and the earlier 37 kept their first places (the first
  three of the 37 rose from 92% to 95%); of 22 exact names one went from
  third to fourth ("Liquibase", another project's word, asked here). Notes of
  another project were picked for 8% of this project's messages (17%), and
  global preferences were picked as before. A larger lead (0.04 and more)
  put the global preference "no release while a question is open" second.
- Notes for each message (`pick`): only notes at least 0.40 close and within
  0.07 of the closest, at most 5, none the member was given in its session
  already unless changed since (the app keeps that per session; it starts
  over when the list is due: a new session, instructions given again, a
  compaction). Tuned on the User's 59 notes, 37 queries and 60 of her real
  messages: notes came for about one message in five, and none for "ok",
  "done" or "I'm home".
- OpenAI not answering in time (4 s for a search, 3 s for a pick): the same
  search by words, and no picks; for 30 s after, nothing waits on OpenAI.
  OpenAI refusing the key (or no credit left, told by its code): the server
  stops using it and Settings says why until a new key is given or the key is
  removed. A refusal of a key replaced meanwhile stops nothing.
- Measured on her notes (2026-11-26): full prints of passages put the right
  note in the first three for all 37 queries; 512 numbers for 95%. Cost: about
  $0.08 once for all her chats, then under a cent a month.

## Keeping it tidy without the User

- A write with the same title in the same kind and place is refused with the
  existing note, so members update instead of adding duplicates.
- A change names the version it is based on; a stale one is refused with the
  current version. A retried request (same `requestId`) changes nothing twice;
  a `requestId` belongs to one member in one chat on one device, and reusing it
  for a different change is refused.
- Kind, scope and field types are checked on every change, not only on create
  (tool schemas are not enforced before the server).
- Whoever merges or releases work updates the status notes of all it ships,
  whoever wrote them: merged or released with the version, or archived once
  nothing is open, lasting knowledge kept as an article first (the User,
  2026-11-27: a release is usually done later by someone else, so a status
  left to its author kept saying "not released" after the release). The
  `release-beta` skill makes it a step of every release. A status of
  repository work is kept at project scope so the releaser sees it (a chat
  status is seen only in its chat); the release report names shipped work
  whose status it could not find.
- A note filed under another project with the same title as one there is
  refused without pointing at that note (the member cannot read or change
  it): it is told to give a more specific title or leave the change to a
  chat of that project.
- A write or archive whose answer did not come says which `requestId` to send
  again: a change that reached the server is then answered as done, not made
  twice (a moved note is no longer found by reading it).
- A status nobody updated for 30 days is archived by the server (swept at most
  every 10 minutes).
- A server keeps at most 2000 unarchived notes; past that a write is refused
  with a request to archive or merge.

## Known limits of v1

- A project is its folder path as the chat names it: a moved or renamed folder
  is another project. A role note follows the role id. A project a member
  files a note under must have a chat on the server.
- The list is not shown again after a compaction the CLI starts on its own, nor
  in a fresh session the CLI starts when a resume fails; members are told to
  search memory when they start a task.
- Search reads the notes holding the first letters of any word asked,
  without an index; fine for hundreds of notes.

## Not in v1

Agreement between members on a note, any trace of memory in
the chat or on the phone, editing a note in Settings, notes of a deleted chat
being removed with it (they stay, shown under "deleted chat", until deleted in
Settings).
