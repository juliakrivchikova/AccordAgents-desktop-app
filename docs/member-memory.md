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
- Title, Markdown body (16 KB at most), up to 12 tags, optional source, author,
  last writer, version, created / updated / last confirmed, archived.

## Repository first

Project knowledge that everyone working with the repository may see goes into
the repository's files, as part of the member's current task (its branch and
changes), so it reaches people and agents working without AccordAgents too.
Memory is for what must not or need not be there: User-specific details,
anything not for a public repository (a member treats a repository as public
unless it checked it is private), know-how beyond one project. With no task to
carry the change, the member keeps it as a project note marked
`awaitingRepository` and moves it into the repository with the next task in
that project, then archives the note.

## Where it lives and who sees what

Notes live on the User's own server (`src/hub/hubMemory.ts`, table
`member_memory_notes`). A member on this computer and a
member on a cloud machine reach the same notes the same way (parity
requirement 1). Every request names the chat and the member; the server checks
against its own copy of that chat that the member is in it and runs on the
device that asks, and takes the member's role and project from the chat, never
from what the member says. The phone has no access; Settings uses owner-only
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
  `app_memory_write`, `app_memory_archive` (`src/shared/appMcpToolContracts.ts`),
  available to every member and auto-approved like documents.
  `app_memory_tags` lists the tags in use on the notes the member sees, most
  used first, so a new note takes a tag already in use instead of a new
  spelling of it (members are told to reuse tags).
- The way to keep memory is part of every member's static instructions
  (`MEMBER_MEMORY_INSTRUCTIONS` in `chat.ts`).
- A session's first turn, a turn that sends the instructions again, and the
  first turn after a compaction carry a short list of relevant notes (titles
  and tags, at most 25): the member's own open statuses first, then project
  notes waiting for the repository, then the most recently used; and a line
  with the most used tags (up to 12). Bodies are
  read with `app_memory_read`, which says who wrote the note and that it is
  reference, not the User's instructions.
- A list or tool call the server could not answer says so and never reads as
  "no memory". The list waits at most 4 s before the turn starts without it.

## Keeping it tidy without the User

- A write with the same title in the same kind and place is refused with the
  existing note, so members update instead of adding duplicates.
- A change names the version it is based on; a stale one is refused with the
  current version. A retried request (same `requestId`) changes nothing twice;
  a `requestId` belongs to one member in one chat on one device, and reusing it
  for a different change is refused.
- Kind, scope and field types are checked on every change, not only on create
  (tool schemas are not enforced before the server).
- A status nobody updated for 30 days is archived by the server (swept at most
  every 10 minutes).
- A note nobody wrote, read or confirmed for 60 days leaves the session-start
  list but is still found by search.
- A server keeps at most 2000 unarchived notes; past that a write is refused
  with a request to archive or merge.

## Known limits of v1

- A project is its folder path as the chat names it: a moved or renamed folder
  is another project. A role note follows the role id.
- The list is not shown again after a compaction the CLI starts on its own, nor
  in a fresh session the CLI starts when a resume fails; members are told to
  search memory when they start a task.
- Search is by words contained in the title, tags or body, without an index;
  fine for hundreds of notes.

## Not in v1

Semantic search, agreement between members on a note, any trace of memory in
the chat or on the phone, editing a note in Settings, notes of a deleted chat
being removed with it (they stay, shown under "deleted chat", until deleted in
Settings).
