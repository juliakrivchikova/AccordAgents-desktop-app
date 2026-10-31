/**
 * Asking before a quit stops what runs in the terminal panel, the way
 * Terminal.app does: a quit while a command runs in a terminal waits for the
 * User's answer; with no terminals, or only shells at their prompts, it goes
 * on at once.
 */
export interface QuitConfirmationOptions {
  /** Shells are running now (nothing to stop otherwise). */
  hasTerminals: () => boolean;
  /** What runs in the terminals (a name, or null when it has none);
   *  undefined when that cannot be told. */
  runningCommands: () => Promise<Array<string | null> | undefined>;
  /** Asks the User; true to quit. Throwing means it could not be asked. */
  ask: (commands: Array<string | null> | undefined) => Promise<boolean>;
  /** Quits again, past this check. */
  quit: () => void;
  log?: (event: string, payload: Record<string, unknown>) => void;
  /** How long a "quit" answer stands. A quit something else stops after it
   *  (a window refusing to unload, a cancelled logout) must not leave the
   *  next quit unasked. */
  confirmedForMs?: number;
}

export interface QuitConfirmation {
  /** Called first on every quit: true when this quit must wait (the caller
   *  then cancels it, and every other quit step stays out). */
  hold: () => boolean;
  /** A quit is waiting for the check or the User's answer (and nothing has
   *  let a quit through meanwhile). */
  holding: () => boolean;
  /** Lets the next quit through unasked: one a program asked for with a
   *  signal, not the User (Terminal.app does not ask then either). */
  allow: () => void;
}

const CONFIRMED_FOR_MS = 30_000;

export function createQuitConfirmation(options: QuitConfirmationOptions): QuitConfirmation {
  let confirmed = false;
  let pending: Promise<void> | undefined;
  const confirm = (): void => {
    confirmed = true;
    const expiry = setTimeout(() => { confirmed = false; }, options.confirmedForMs ?? CONFIRMED_FOR_MS);
    expiry.unref?.();
  };

  const decide = async (): Promise<void> => {
    let proceed = true;
    try {
      const commands = await options.runningCommands();
      if (commands === undefined || commands.length > 0) {
        options.log?.("app-quit.confirm-asked", { commands: commands ?? null });
        proceed = await options.ask(commands);
        options.log?.("app-quit.confirm-answered", { quit: proceed });
      }
    } catch (error) {
      // A question that cannot be asked must not keep the app from quitting.
      options.log?.("app-quit.confirm-failed", { error: error instanceof Error ? error.message : String(error) });
      proceed = true;
    }
    if (!proceed) return;
    confirm();
    // Quit again only after this turn: a quit that started in native code
    // (Cmd+Q, the Dock, a signal) is still unwinding, and a nested quit inside
    // it is lost (see main.ts's before-quit).
    setImmediate(() => options.quit());
  };

  return {
    hold: () => {
      if (confirmed) return false;
      if (pending) return true;
      if (!options.hasTerminals()) return false;
      pending = decide().finally(() => { pending = undefined; });
      return true;
    },
    holding: () => Boolean(pending) && !confirmed,
    allow: confirm
  };
}

interface QuitEvent {
  preventDefault: () => void;
}

interface QuitEmitter {
  prependListener: (event: "before-quit", listener: (event: QuitEvent) => void) => unknown;
}

/** Puts the check ahead of every other quit step. */
export function installQuitConfirmation(app: QuitEmitter, confirmation: QuitConfirmation): void {
  app.prependListener("before-quit", (event) => {
    if (confirmation.hold()) event.preventDefault();
  });
}

/** A quit step that does nothing while the quit waits for the User. */
export function quitStep<E>(confirmation: QuitConfirmation, step: (event: E) => void): (event: E) => void {
  return (event) => {
    if (confirmation.holding()) return;
    step(event);
  };
}

/** The question's text: what quitting stops. */
export function quitConfirmationDetail(commands: Array<string | null> | undefined): string {
  const names = [...new Set((commands ?? []).filter((name): name is string => Boolean(name)))];
  if (!names.length) {
    return "A command is still running in the terminal. Quitting stops it.";
  }
  const listed = names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", ");
  return names.length === 1
    ? `${listed} is still running in the terminal. Quitting stops it.`
    : `${listed} are still running in the terminal. Quitting stops them.`;
}
