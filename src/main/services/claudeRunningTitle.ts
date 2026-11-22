// How Claude Code turns a tool call's description into the title of its row
// while it runs: "Run loop, list files, print long line" reads "Running loop,
// listing files, printing long line". Ported from Claude Code 2.1.330 (its
// title for a call with a `description`, verified against a real session):
// when the first word is a verb it knows, that verb and the verbs that open
// the clauses after it (", list", "and print", "then run") take their -ing
// form; any other description is shown as written.

const VOWEL = /[aeiou]/i;
const CONSONANT_VOWEL_CONSONANT = /[^aeiou][aeiou][bcdfghjklmnpqrstvz]$/i;

/** Irregular past forms: a word that is one is not taken for a verb to put
 *  in its -ing form. */
const IRREGULAR_PAST: Record<string, string> = {
  begin: "began", bind: "bound", bring: "brought", build: "built", buy: "bought", catch: "caught", choose: "chose",
  come: "came", cut: "cut", debug: "debugged", dig: "dug", do: "did", draw: "drew", feed: "fed", feel: "felt",
  fight: "fought", find: "found", fly: "flew", forget: "forgot", freeze: "froze", get: "got", give: "gave", go: "went",
  have: "had", hide: "hid", hit: "hit", hold: "held", input: "input", keep: "kept", know: "knew", lead: "led",
  leave: "left", let: "let", lose: "lost", make: "made", mean: "meant", meet: "met", override: "overrode",
  overwrite: "overwrote", pay: "paid", put: "put", quit: "quit", read: "read", rebuild: "rebuilt", redo: "redid",
  rerun: "reran", reset: "reset", rewrite: "rewrote", run: "ran", see: "saw", seek: "sought", send: "sent", set: "set",
  show: "showed", shut: "shut", sit: "sat", sleep: "slept", spend: "spent", spin: "spun", split: "split",
  spread: "spread", stand: "stood", sweep: "swept", sync: "synced", take: "took", teach: "taught", tear: "tore",
  tell: "told", think: "thought", throw: "threw", understand: "understood", undo: "undid", unset: "unset", win: "won",
  unwrap: "unwrapped", unzip: "unzipped", write: "wrote"
};

/** -ing forms the rules below would get wrong. */
const IRREGULAR_RUNNING: Record<string, string> = {
  begin: "beginning", commit: "committing", control: "controlling", debug: "debugging", emit: "emitting",
  equip: "equipping", forget: "forgetting", format: "formatting", input: "inputting", occur: "occurring",
  omit: "omitting", output: "outputting", permit: "permitting", prefer: "preferring", quit: "quitting",
  refer: "referring", rerun: "rerunning", reset: "resetting", screenshot: "screenshotting", snapshot: "snapshotting",
  submit: "submitting", sync: "syncing", transfer: "transferring", unset: "unsetting", unwrap: "unwrapping",
  unzip: "unzipping"
};

const PAST_FORMS = new Set([
  ...Object.entries(IRREGULAR_PAST).filter(([verb, past]) => verb !== past).map(([, past]) => past),
  "been", "broken", "chosen", "done", "drawn", "driven", "eaten", "fallen", "forgotten", "given", "gone", "grown",
  "hidden", "known", "ridden", "risen", "seen", "shown", "spoken", "taken", "thrown", "torn", "worn", "written"
]);

/** Verbs that are as often nouns or adjectives ("output", "set", "read"):
 *  never taken as the verb of a later clause. */
const AMBIGUOUS = new Set([
  "output", "input", "lead", "feed", "spread", "set", "cut", "split", "hit", "let", "put", "quit", "shut", "read", "go",
  "make", "dig", "tear", "win", "fly", "spin", "control", "permit", "have", "hold", "keep", "mean", "feel", "do", "see",
  "know", "think", "understand"
]);

const KNOWN_VERBS = new Set([
  ...Object.keys(IRREGULAR_PAST).filter((verb) => !AMBIGUOUS.has(verb)),
  ...Object.keys(IRREGULAR_RUNNING).filter((verb) => !AMBIGUOUS.has(verb)),
  "add", "analyze", "append", "apply", "archive", "assert", "attempt", "autofix", "await", "benchmark", "bisect", "call",
  "capture", "check", "clone", "collect", "compare", "compile", "compute", "confirm", "connect", "convert", "copy",
  "count", "create", "curl", "decode", "delete", "deploy", "detect", "discard", "dismiss", "display", "download", "dump",
  "edit", "emit", "enable", "encode", "ensure", "enumerate", "evaluate", "execute", "expand", "expect", "export",
  "extract", "fetch", "fill", "filter", "fix", "flush", "focus", "follow", "generate", "grep", "identify", "ignore",
  "import", "include", "inject", "insert", "inspect", "install", "invoke", "kill", "launch", "lint", "list", "load",
  "locate", "loop", "measure", "merge", "monitor", "move", "navigate", "normalize", "parse", "patch", "pick", "ping",
  "pipe", "poll", "post", "prepare", "preview", "print", "probe", "profile", "prune", "publish", "pull", "push", "queue",
  "rebase", "recheck", "record", "recover", "redirect", "reduce", "refresh", "regenerate", "reinstall", "relaunch",
  "reload", "remove", "rename", "render", "reopen", "repeat", "replay", "reply", "report", "request", "resolve",
  "restart", "restore", "retry", "revert", "save", "scan", "screenshot", "scroll", "search", "select", "serialize",
  "serve", "settle", "skip", "snapshot", "sort", "spawn", "squash", "stage", "start", "stash", "stop", "strip",
  "summarize", "switch", "sync", "tail", "tally", "test", "toggle", "touch", "trace", "track", "trigger", "trim",
  "truncate", "try", "typecheck", "unblock", "uninstall", "unlink", "unmount", "unpack", "update", "upgrade", "upload",
  "validate", "verify", "visit", "wait", "walk", "warn", "wipe"
]);

/** A later clause's verb: after ", " or "and"/"then". */
const LATER_CLAUSE_VERB = /(?:(?<![\w-])((?:(?:[Aa]nd|[Tt]hen)\s+)+)|(,\s+(?:(?:and|then)\s+)*))([a-z]{2,16})(?=$|[\s,;!?]|\.(?:\s|$))/g;
/** What follows a word that makes it a subject, not a verb ("check passes"). */
const SUBJECT_FOLLOWS = /^(?:\s+\w+){0,2}\s+(?:is|are|was|were|has|have|do|does|did|will|would|should|can|could|passes|passed|fails|failed|exists|works|worked|succeeds|succeeded|stays|remains|looks|runs|ran|not|if|when|unless|whether)(?:n['’]t)?\b/;
const PREFIXED = /^(re|un|de|pre|co|sub|over|out|mis|auto|post)-(.+)$/i;

function vowelCount(word: string): number {
  return (word.match(/[aeiou]/gi) ?? []).length;
}

function runningForm(word: string): string {
  const lower = word.toLowerCase();
  if (Object.hasOwn(IRREGULAR_RUNNING, lower)) return IRREGULAR_RUNNING[lower];
  if (/ie$/i.test(word)) return `${word.slice(0, -2)}ying`;
  if (/[^eoy]e$/i.test(word)) return `${word.slice(0, -1)}ing`;
  if (CONSONANT_VOWEL_CONSONANT.test(word) && vowelCount(word) === 1) return `${word}${word.slice(-1)}ing`;
  if (/c$/i.test(word)) return `${word}king`;
  return `${word}ing`;
}

function withCaseOf(original: string, form: string): string {
  return /^[A-Z]/.test(original) ? form.charAt(0).toUpperCase() + form.slice(1) : form;
}

function couldBeVerb(word: string): boolean {
  if (word.length < 2 || word.length > 16) return false;
  if (!/^[A-Za-z]+$/.test(word)) return false;
  if (word === word.toUpperCase()) return false;
  const lower = word.toLowerCase();
  if (PAST_FORMS.has(lower)) return false;
  if (Object.hasOwn(IRREGULAR_PAST, lower)) return true;
  if (/ing$/i.test(word) && word.length > 4) return false;
  if (/ed$/i.test(word) && !/eed$/i.test(word) && word.length > 3) return false;
  if (/s$/i.test(word) && !/(ss|us)$/i.test(word) && word.length > 3) return false;
  return VOWEL.test(word) || /y/i.test(word);
}

function laterClausesRunning(text: string): string {
  return text.replace(LATER_CLAUSE_VERB, (match: string, joiner: string | undefined, comma: string | undefined, verb: string, offset: number) =>
    KNOWN_VERBS.has(verb) && !SUBJECT_FOLLOWS.test(text.slice(offset + match.length))
      ? (joiner ?? comma ?? "") + runningForm(verb)
      : match);
}

function runningTitle(description: string): string | undefined {
  const trimmed = description.trimStart();
  const lead = description.slice(0, description.length - trimmed.length);
  const parts = /^(\S+)([\s\S]*)$/.exec(trimmed);
  if (!parts) return undefined;
  const first = parts[1];
  const rest = parts[2] ?? "";
  const prefixed = PREFIXED.exec(first);
  if (prefixed && prefixed[2] !== undefined && couldBeVerb(prefixed[2])) {
    const prefix = prefixed[1];
    const stem = prefixed[2];
    const whole = (prefix + stem).toLowerCase();
    if (PAST_FORMS.has(whole) || PAST_FORMS.has(stem.toLowerCase())) return undefined;
    const running = Object.hasOwn(IRREGULAR_RUNNING, whole) ? IRREGULAR_RUNNING[whole].slice(prefix.length) : runningForm(stem);
    return `${lead}${prefix}-${withCaseOf(stem, running)}${laterClausesRunning(rest)}`;
  }
  if (!couldBeVerb(first)) return undefined;
  return `${lead}${withCaseOf(first, runningForm(first))}${laterClausesRunning(rest)}`;
}

/** A tool call's description as the title of its running row: in its -ing
 *  form when it starts with a verb Claude Code knows, else undefined (the
 *  CLI then shows the description as written). */
export function claudeRunningTitle(description: string): string | undefined {
  const first = /^\s*(\S+)/.exec(description)?.[1];
  if (first === undefined) return undefined;
  const verb = (PREFIXED.exec(first)?.[2] ?? first).toLowerCase();
  return KNOWN_VERBS.has(verb) || Object.hasOwn(IRREGULAR_PAST, verb) || Object.hasOwn(IRREGULAR_RUNNING, verb)
    ? runningTitle(description)
    : undefined;
}
