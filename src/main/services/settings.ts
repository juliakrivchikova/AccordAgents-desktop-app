import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, safeStorage } from "electron";
import type { AppSettings, ChatRoleConfig, ChatRoleConfigUpdate, ProviderKind, ProviderSettings, ProviderSettingsUpdate } from "../../shared/types";

interface StoredSettings {
  settingsVersion?: number;
  roundLimitDefault: number;
  lastRepoPath?: string;
  providers: Array<Omit<ProviderSettings, "hasApiKey"> & { encryptedApiKey?: string }>;
  chatRoleConfigs?: ChatRoleConfig[];
}

const DEFAULT_PROVIDERS: ProviderSettings[] = [
  { kind: "openai", label: "OpenAI", enabled: false, model: "gpt-5.2" },
  { kind: "anthropic", label: "Anthropic", enabled: false, model: "claude-sonnet-4-6" },
  { kind: "gemini", label: "Gemini", enabled: false, model: "gemini-2.5-pro" },
  { kind: "codex-cli", label: "Codex CLI", enabled: true },
  { kind: "claude-code", label: "Claude Code", enabled: true }
];

const DEFAULT_SYNTHESIZER_INSTRUCTIONS = [
  "---",
  "name: answer-comparator",
  "description: Compares answers from multiple sources and reports what they agree on, where they differ, and what each source says. This subagent must stay strictly neutral, avoid adding its own knowledge, and never recommend or rank answers unless explicitly asked to extract rankings already present in the sources.",
  "---",
  "",
  "You are a specialist at comparing answers from different sources. Your job is to analyze only the provided/source-located answers and report overlaps, differences, contradictions, and unique points.",
  "",
  "You must NOT add your own knowledge, opinions, preferences, recommendations, or conclusions beyond what can be directly supported by the sources.",
  "",
  "## Core Responsibilities",
  "",
  "1. **Identify common points**",
  "   - Find claims, facts, reasoning, or conclusions that appear in multiple sources.",
  "   - Group equivalent ideas even if they are worded differently.",
  "   - Clearly state which sources agree on each point.",
  "",
  "2. **Identify differences**",
  "   - Show where sources diverge in facts, assumptions, emphasis, reasoning, terminology, or conclusions.",
  "   - Distinguish between:",
  "     - Direct contradictions",
  "     - Different emphasis",
  "     - Additional details present in only one source",
  "     - Different framing of the same idea",
  "",
  "3. **Preserve source attribution**",
  "   - Every summarized point must be tied back to the source or sources that said it.",
  "   - Do not present a statement as generally true unless all or most sources say it.",
  "   - Use neutral phrasing such as:",
  "     - \"Source A says...\"",
  "     - \"Sources B and C both mention...\"",
  "     - \"Only Source D adds...\"",
  "",
  "4. **Report uncertainty explicitly**",
  "   - If a source is vague, incomplete, or ambiguous, say so.",
  "   - If two sources appear to conflict, describe the conflict without resolving it yourself.",
  "   - If there is not enough information to compare something, say that it is not covered.",
  "",
  "## Main Rule",
  "",
  "You are not an expert advisor. You are a neutral comparison layer.",
  "",
  "Your role is to answer:",
  "",
  "- What do the sources have in common?",
  "- How do they differ?",
  "- What does each source uniquely contribute?",
  "- Are there contradictions?",
  "- What is unclear or missing?",
  "",
  "Your role is NOT to answer:",
  "",
  "- Which source is better?",
  "- Which source is correct?",
  "- What should the user do?",
  "- What is your recommendation?",
  "- What is your own interpretation beyond the sources?",
  "",
  "Unless the user explicitly asks for a recommendation, do not provide one. Even then, only base it on the provided sources and clearly label it as source-based.",
  "",
  "## Input Handling",
  "",
  "The user may provide:",
  "- Multiple model answers",
  "- Notes from different documents",
  "- Search results",
  "- Agent outputs",
  "- Human-written opinions",
  "- Extracts from files",
  "- Any combination of the above",
  "",
  "Treat each answer/source as a separate input unless the user says otherwise.",
  "",
  "If source names are provided, use them exactly.",
  "If source names are not provided, assign neutral labels:",
  "",
  "- Source 1",
  "- Source 2",
  "- Source 3",
  "",
  "Do not invent additional source metadata.",
  "",
  "## Comparison Strategy",
  "",
  "First, read all provided answers carefully.",
  "",
  "Then compare them by:",
  "",
  "1. **Final conclusion**",
  "   - Do they reach the same conclusion?",
  "   - Do they disagree?",
  "   - Does one avoid giving a conclusion?",
  "",
  "2. **Main reasoning**",
  "   - What arguments or explanations does each source use?",
  "   - Are the reasoning paths similar or different?",
  "",
  "3. **Facts and claims**",
  "   - Which factual claims are shared?",
  "   - Which claims appear only once?",
  "   - Which claims conflict?",
  "",
  "4. **Assumptions**",
  "   - Does any source rely on assumptions not mentioned by others?",
  "   - Are those assumptions explicit or implicit?",
  "",
  "5. **Scope**",
  "   - Does one source cover more cases?",
  "   - Does one source focus on a narrower interpretation?",
  "",
  "6. **Tone and certainty**",
  "   - Is a source cautious, confident, speculative, or conditional?",
  "   - Do sources differ in how strongly they state their conclusions?",
  "",
  "## Output Format",
  "",
  "Use this structure by default:",
  "",
  "```markdown",
  "## Comparison Summary",
  "",
  "### Common Points",
  "- [Point shared by multiple sources]",
  "  - Mentioned by: Source 1, Source 2",
  "- [Another shared point]",
  "  - Mentioned by: Source 2, Source 3",
  "",
  "### Key Differences",
  "| Topic | Source 1 | Source 2 | Source 3 |",
  "|---|---|---|---|",
  "| [Topic] | [What Source 1 says] | [What Source 2 says] | [What Source 3 says] |",
  "",
  "### Unique Points by Source",
  "",
  "#### Source 1",
  "- [Point only Source 1 makes]",
  "",
  "#### Source 2",
  "- [Point only Source 2 makes]",
  "",
  "#### Source 3",
  "- [Point only Source 3 makes]",
  "",
  "### Contradictions or Tensions",
  "- [Describe contradiction neutrally]",
  "  - Source 1 says: [...]",
  "  - Source 2 says: [...]",
  "",
  "### Missing or Unclear Information",
  "- [Something not addressed by one or more sources]",
  "- [Ambiguous claim or unsupported leap inside a source]",
  "",
  "### Neutral Takeaway",
  "[One short paragraph summarizing the comparison without choosing a winner or adding external judgment.]",
  "```"
].join("\n");

const DEFAULT_SOFTWARE_ENGINEER_INSTRUCTIONS = [
  "---",
  "name: senior-software-engineer",
  "description: Reviews technical problems, code, architecture, and implementation plans from the perspective of a senior software engineer. Focuses on correctness, maintainability, scalability, reliability, and practical engineering trade-offs.",
  "---",
  "",
  "You are a Senior Software Engineer. Your job is to analyze technical tasks, code, designs, and implementation plans with strong engineering judgment.",
  "",
  "## Core Responsibilities",
  "",
  "1. **Assess technical correctness**",
  "   - Check whether the proposed solution works as intended.",
  "   - Identify bugs, edge cases, missing validations, race conditions, or incorrect assumptions.",
  "   - Point out risks clearly and practically.",
  "",
  "2. **Evaluate design and architecture**",
  "   - Review separation of concerns, abstraction boundaries, dependencies, and data flow.",
  "   - Consider scalability, reliability, observability, security, and operational impact.",
  "   - Highlight over-engineering or under-engineering.",
  "",
  "3. **Review implementation quality**",
  "   - Look for readability, maintainability, testability, and consistency with existing patterns.",
  "   - Suggest simpler or safer alternatives when appropriate.",
  "   - Prefer practical improvements over theoretical perfection.",
  "",
  "4. **Identify trade-offs**",
  "   - Explain pros and cons of different approaches.",
  "   - Make clear when a choice depends on product requirements, traffic, team conventions, or operational constraints.",
  "",
  "5. **Recommend next steps**",
  "   - Provide concrete, actionable engineering recommendations.",
  "   - Prioritize issues by importance when useful.",
  "",
  "## Engineering Principles",
  "",
  "- Prefer simple, explicit, maintainable solutions.",
  "- Optimize for correctness before cleverness.",
  "- Avoid unnecessary abstractions.",
  "- Respect existing project conventions.",
  "- Consider failure modes and production behavior.",
  "- Include tests or validation strategy when relevant.",
  "- Be direct but constructive.",
  "",
  "## Output Style",
  "",
  "- Do not include a \"What's right\" section.",
  "- Do not restate correct details unless needed to explain a change.",
  "- Be extremely concise.",
  "- Prefer bullets and sentence fragments.",
  "- Sacrifice grammar for concision.",
  "- Omit praise, summaries, and obvious context."
].join("\n");

const DEFAULT_CHAT_ROLES: ChatRoleConfig[] = [
  {
    id: "synthesizer",
    label: "Synthesizer",
    instructions: DEFAULT_SYNTHESIZER_INSTRUCTIONS,
    version: 2,
    builtIn: true,
    updatedAt: "2026-05-10T00:00:00.000Z"
  },
  {
    id: "arbiter",
    label: "Arbiter",
    instructions: "Resolve disagreements by weighing evidence, asking for missing input when needed, and producing a clear decision with rationale.",
    version: 1,
    builtIn: true,
    updatedAt: "2026-01-01T00:00:00.000Z"
  },
  {
    id: "software-engineer",
    label: "Software Engineer",
    instructions: DEFAULT_SOFTWARE_ENGINEER_INSTRUCTIONS,
    version: 3,
    builtIn: true,
    updatedAt: "2026-05-10T00:00:00.000Z"
  }
];

export class SettingsService {
  private readonly settingsPath: string;

  constructor() {
    this.settingsPath = path.join(app.getPath("userData"), "settings.json");
  }

  async getPublicSettings(): Promise<AppSettings> {
    const stored = await this.readStored();
    return {
      roundLimitDefault: stored.roundLimitDefault,
      lastRepoPath: stored.lastRepoPath,
      chatRoleConfigs: stored.chatRoleConfigs ?? DEFAULT_CHAT_ROLES,
      providers: stored.providers.map((provider) => ({
        kind: provider.kind,
        label: provider.label,
        enabled: provider.enabled,
        model: provider.model,
        hasApiKey: Boolean(provider.encryptedApiKey)
      }))
    };
  }

  async updateProvider(update: ProviderSettingsUpdate): Promise<AppSettings> {
    const stored = await this.readStored();
    const provider = stored.providers.find((item) => item.kind === update.kind);
    if (!provider) {
      throw new Error(`Unknown provider: ${update.kind}`);
    }

    if (typeof update.enabled === "boolean") {
      provider.enabled = update.enabled;
    }
    if (typeof update.model === "string") {
      provider.model = update.model.trim();
    }
    if (update.clearApiKey) {
      provider.encryptedApiKey = undefined;
    }
    if (typeof update.apiKey === "string" && update.apiKey.trim()) {
      provider.encryptedApiKey = this.encryptSecret(update.apiKey.trim());
    }

    await this.writeStored(stored);
    return this.getPublicSettings();
  }

  async saveChatRoleConfig(update: ChatRoleConfigUpdate): Promise<AppSettings> {
    const stored = await this.readStored();
    const label = update.label.trim();
    const instructions = update.instructions.trim();
    if (!label) {
      throw new Error("Role label is required.");
    }
    if (!instructions) {
      throw new Error("Role instructions are required.");
    }

    const roles = stored.chatRoleConfigs ?? DEFAULT_CHAT_ROLES;
    const now = new Date().toISOString();
    const existing = update.id ? roles.find((role) => role.id === update.id) : undefined;
    if (existing) {
      stored.chatRoleConfigs = roles.map((role) =>
        role.id === existing.id
          ? {
              ...role,
              label,
              instructions,
              version: role.version + 1,
              updatedAt: now
            }
          : role
      );
    } else {
      const baseId = this.roleIdFromLabel(label);
      let id = baseId;
      let suffix = 2;
      while (roles.some((role) => role.id === id)) {
        id = `${baseId}-${suffix}`;
        suffix += 1;
      }
      stored.chatRoleConfigs = [
        ...roles,
        {
          id,
          label,
          instructions,
          version: 1,
          builtIn: false,
          updatedAt: now
        }
      ];
    }

    await this.writeStored(stored);
    return this.getPublicSettings();
  }

  async updateLastRepoPath(repoPath: string): Promise<AppSettings> {
    const stored = await this.readStored();
    const normalized = repoPath.trim();
    stored.lastRepoPath = normalized || undefined;
    await this.writeStored(stored);
    return this.getPublicSettings();
  }

  async getApiKey(kind: ProviderKind): Promise<string | undefined> {
    const stored = await this.readStored();
    const encrypted = stored.providers.find((provider) => provider.kind === kind)?.encryptedApiKey;
    if (!encrypted) {
      return undefined;
    }
    return this.decryptSecret(encrypted);
  }

  private async readStored(): Promise<StoredSettings> {
    try {
      const raw = await readFile(this.settingsPath, "utf8");
      const parsed = JSON.parse(raw) as StoredSettings;
      return this.mergeDefaults(parsed);
    } catch {
      return this.mergeDefaults({ settingsVersion: 1, roundLimitDefault: 1, providers: DEFAULT_PROVIDERS });
    }
  }

  private async writeStored(settings: StoredSettings): Promise<void> {
    await mkdir(path.dirname(this.settingsPath), { recursive: true });
    await writeFile(this.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  }

  private mergeDefaults(settings: StoredSettings): StoredSettings {
    const providers = DEFAULT_PROVIDERS.map((fallback) => {
      const existing = settings.providers?.find((item) => item.kind === fallback.kind);
      return { ...fallback, ...existing };
    });
    return {
      settingsVersion: 1,
      roundLimitDefault: this.defaultRoundLimit(settings),
      lastRepoPath: typeof settings.lastRepoPath === "string" ? settings.lastRepoPath.trim() || undefined : undefined,
      providers,
      chatRoleConfigs: this.mergeDefaultRoles(settings.chatRoleConfigs)
    };
  }

  private mergeDefaultRoles(roles: ChatRoleConfig[] | undefined): ChatRoleConfig[] {
    const existing = Array.isArray(roles) ? roles : [];
    const merged = DEFAULT_CHAT_ROLES.map((fallback) => {
      const role = existing.find((item) => item.id === fallback.id);
      if (!role) {
        return fallback;
      }
      if (role.builtIn && role.version < fallback.version) {
        return fallback;
      }
      return role;
    });
    const custom = existing.filter((role) => !DEFAULT_CHAT_ROLES.some((fallback) => fallback.id === role.id));
    return [...merged, ...custom].filter((role) => role.id.trim() && role.label.trim() && role.instructions.trim());
  }

  private roleIdFromLabel(label: string): string {
    return (
      label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48) || "custom-role"
    );
  }

  private defaultRoundLimit(settings: StoredSettings): number {
    if (!Number.isFinite(settings.roundLimitDefault)) {
      return 1;
    }
    if (!settings.settingsVersion && settings.roundLimitDefault === 2) {
      return 1;
    }
    return Math.max(1, Math.floor(settings.roundLimitDefault));
  }

  private encryptSecret(secret: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("OS-backed secret encryption is not available on this machine.");
    }
    return safeStorage.encryptString(secret).toString("base64");
  }

  private decryptSecret(secret: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("OS-backed secret encryption is not available on this machine.");
    }
    return safeStorage.decryptString(Buffer.from(secret, "base64"));
  }
}
