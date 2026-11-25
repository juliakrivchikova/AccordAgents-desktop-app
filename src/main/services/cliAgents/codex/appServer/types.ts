export interface CodexAppServerThreadStartResult {
  thread?: {
    id?: string;
    sessionId?: string;
  };
  model?: string;
  /** The effort the thread runs at (the User's config.toml when the member
   *  sets none). */
  reasoningEffort?: string | null;
}
