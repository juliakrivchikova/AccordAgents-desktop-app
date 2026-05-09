# Repository Guidelines

## Project Structure & Module Organization

This is an Electron desktop app built with TypeScript, React, and Vite. Main-process code lives in `src/main`, with service classes under `src/main/services`. The preload bridge is in `src/preload`, shared types and utilities are in `src/shared`, and the React renderer is in `src/renderer`. Renderer assets belong in `src/renderer/assets`, and app-wide styles are in `src/renderer/styles/app.css`. Build output goes to `dist`; do not edit generated files by hand.

## Build, Test, and Development Commands

Prefer the Makefile aliases when working locally:

- `make install`: install Node dependencies with `npm install`.
- `make dev`: run the Vite dev server and launch Electron.
- `make start`: build the app and run Electron from `dist`.
- `make build`: compile the main process and build the renderer.
- `make typecheck`: run strict TypeScript checks.
- `make clean`: remove `dist`.

Equivalent npm scripts are in `package.json`, for example `npm run dev`, `npm run build`, and `npm run typecheck`.

## Coding Style & Naming Conventions

Use strict TypeScript and keep types explicit at IPC, service, and shared boundaries. Match the existing style: 2-space indentation, double quotes, semicolons, and named imports. React components and service classes use `PascalCase`; functions, hooks, variables, and IPC handlers use `camelCase`. Keep shared contracts in `src/shared/types.ts`.

## Testing Guidelines

No automated test framework is currently configured. Until one is added, run `make typecheck` and `make build` before submitting changes. For behavior that touches Electron IPC, provider integrations, git diff handling, or conversation storage, include manual verification notes in the PR. If adding tests, colocate them near the code under test or use `*.test.ts` / `*.test.tsx`, and add the command to `package.json`.

## Commit & Pull Request Guidelines

Existing commits use short, imperative summaries such as `Add Makefile for app commands` and `Compare selected branches in diff mode`. Follow that style: describe the user-visible or technical change in one sentence.

PRs should include a concise description, validation commands run, linked issues when applicable, and screenshots or short recordings for renderer UI changes. Call out changes to stored conversation data, settings, provider configuration, or CLI-agent behavior.

## Security & Configuration Tips

Do not commit provider API keys, local paths, generated logs, `node_modules`, or `dist`. Treat settings and debug logs as sensitive when they include prompts, diffs, or model responses.
