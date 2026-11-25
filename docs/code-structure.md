# How the code is cut into files

No source file is longer than 1000 lines (`make lint-lines`,
`scripts/file-lengths.test.mjs`). A file that grows past it is cut by subject,
never by line count alone.

## A service in parts

A service that outgrew one file is a facade and a folder of the same name:

- `chat.ts` — the facade: the class the rest of the app uses. It holds no state
  and no logic; each method hands the call to the part that owns it.
- `chat/` — the parts. One subject per folder (`turns`, `approvals`, `members`,
  …), one part per file. A part is a class that owns its state, or a file of
  plain functions that read none.
- `chat/modules.ts` — the registry: every part once, built in one place. A part
  names the other parts it uses in its constructor
  (`Pick<ChatModules, "store" | "activeRuns">`), so what it touches is read off
  its first lines.
- `chat/dependencies.ts` — what the service is given from outside (storage,
  settings, …), named by each part the same way.
- `chat/types.ts`, `chat/constants.ts` — what several parts share; what one
  folder shares is in that folder.

`cliAgents`, `settings`, `storage`, `consensus`, `artifacts`, `artifactStore`,
`cloudRunAws`, `scripts`, `machineLink`, `machineInstaller`, `appMcp` and, in
`src/hub`, `hubOps`, `hubServer` and `hubAlerts` are built the same way.
`codexApprovals`, `remoteAgentSetup`, `hubMachineScope`, `shared/types` and
`shared/appMcpToolContracts` are folders of functions or types behind an entry
file: import them from the entry.

Rules:

- A field belongs to one part. Others read it through that part, or call a
  method of it; they do not keep a copy.
- Parts import each other's types only; values go through the registry. A plain
  function file may import another one. Nothing imports in a circle at run time.
- File names are camelCase and differ by more than case (macOS).
- New code goes to the part whose subject it is; a new subject is a new part.

## The app itself

`src/main/main.ts` starts the app step by step; each step is a file of
`src/main/desktopApp/`. They share one object, `DesktopApp`
(`desktopApp.ts`): its services, its window and what it is doing. The IPC
handlers are in `desktopApp/ipc/`, one file per subject.

## The phone app

`src/mobile/app/` holds its modules, `src/mobile/styles/` its styles;
`scripts/build-mobile-shell.mjs` puts them into the two files the phone loads,
`mobile-app.js` and `mobile-app.css`. A variable that several modules write is a
property of its module's `…State` object. Styles override each other in the
order the build script lists them.

## Tests and guards

- A test of a part reaches it through `test/<service>Parts.ts` in the service's
  folder (`chatParts(service).turnQueue`). A stub set on the facade does
  nothing for calls between parts.
- A big test file is several files by topic (`chat.permissions.<topic>.test.ts`);
  what they share is a fixtures file in the service's `test` folder. Folders
  named `test` are not packaged.
- A guard that reads a service's source reads all its parts with
  `sourceParts` or `sourceText` (`scripts/source-parts.mjs`).
