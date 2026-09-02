# Known Issues

## Active chat streaming can consume excessive CPU and memory

- **Status:** Open
- **Observed:** 2026-08-19 on macOS while a local Codex participant was actively streaming.
- **Impact:** The AccordAgents renderer sustained 18–41% CPU and used about 1.1 GB of physical memory. The GPU process was only 2–4% during the sustained measurement. An isolated idle instance used about 4.3 MB of JavaScript heap and had negligible renderer task time, so the problem is specific to active chat state rather than Electron at idle.
- **Suspected cause:** `ChatService` emits cumulative progress snapshots as often as every 250 ms (`src/main/services/chat.ts`), while `useAppEffects` retains up to 500 snapshots and commits them into React state (`src/renderer/app/use-app-effects.ts`). Repeated cumulative `partialContent` and `activityEvents` may amplify allocation, reconciliation, and rendering costs.
- **Next step:** Profile an active renderer through CDP, then replace retained cumulative snapshots with bounded latest-per-run state or deltas without changing dedicated CLI streaming behavior.

## Automatic chat titles reject Cyrillic-only text

- **Status:** Open
- **Observed:** 2026-08-19. Calling `app_chat_set_title` with `Почему греется компьютер` returned `ignored: invalid_title`, leaving the title as `Chat`.
- **Cause:** `isUsefulAutoChatTitle` in `src/shared/chatTitles.ts` requires at least one ASCII letter or digit via `/[A-Za-z0-9]/`, so valid titles written only in Cyrillic or other non-Latin scripts are rejected.
- **Next step:** Validate useful titles with Unicode letters/numbers and add coverage for Cyrillic and other supported scripts while preserving generic-title and provider-name rejection.
