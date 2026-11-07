import { useEffect, useRef, useState } from "react";
import { LogIn, X } from "lucide-react";

import { isCliSignInRunning } from "../../../shared/cliReadiness";
import type { CliSignInKind, CliSignInState } from "../../../shared/types";
import { cleanIpcError } from "../../lib/ipc-error";

export interface CliSignInsView {
  signIns: Partial<Record<CliSignInKind, CliSignInState>>;
  /** CLIs that just signed in and whose readiness is being checked again. */
  checkingAfterSignIn: Partial<Record<CliSignInKind, true>>;
}

/** The newest state of each CLI's sign-in, as the app reports it. A sign-in
 *  that succeeds while the panel is open asks for a fresh readiness check,
 *  which flips the card. A reopened panel picks up only sign-ins still
 *  running: an old result would describe a readiness that has moved on. */
export function useCliSignIns(onSignedIn: () => Promise<void>): CliSignInsView {
  const [signIns, setSignIns] = useState<Partial<Record<CliSignInKind, CliSignInState>>>({});
  const [checkingAfterSignIn, setCheckingAfterSignIn] = useState<Partial<Record<CliSignInKind, true>>>({});
  const onSignedInRef = useRef(onSignedIn);
  onSignedInRef.current = onSignedIn;

  useEffect(() => {
    let mounted = true;
    const accept = (state: CliSignInState, live: boolean): void => {
      if (!mounted || (!live && !isCliSignInRunning(state.status))) return;
      setSignIns((current) => {
        // Revisions only grow in the app, across every sign-in.
        const known = current[state.kind];
        return known && known.revision >= state.revision ? current : { ...current, [state.kind]: state };
      });
      if (live && state.status === "succeeded") {
        setCheckingAfterSignIn((current) => ({ ...current, [state.kind]: true }));
        void onSignedInRef.current().finally(() => {
          if (mounted) setCheckingAfterSignIn(({ [state.kind]: _done, ...rest }) => rest);
        });
      }
    };
    const unsubscribe = window.consensus.onCliSignInUpdated?.((state) => accept(state, true));
    void window.consensus.listCliSignIns?.()
      .then((states) => states.forEach((state) => accept(state, false)))
      .catch(() => undefined);
    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, []);

  return { signIns, checkingAfterSignIn };
}

export function CliSignInStep(props: {
  kind: CliSignInKind;
  label: string;
  signIn?: CliSignInState;
  /** This sign-in just succeeded and readiness is being checked again. */
  checkingAfterSignIn: boolean;
  onError: (message: string | undefined) => void;
}): JSX.Element {
  const signIn = props.signIn;
  const running = isCliSignInRunning(signIn?.status);
  const [starting, setStarting] = useState(false);
  const [codeFieldFor, setCodeFieldFor] = useState<string | undefined>();
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | undefined>();
  const [cancelling, setCancelling] = useState(false);
  const showCodeField = running && Boolean(signIn?.pageGivesCode) && codeFieldFor === signIn?.requestId;

  useEffect(() => {
    if (!running) {
      setCancelling(false);
      setCode("");
      setCodeError(undefined);
    }
  }, [running]);

  async function start(): Promise<void> {
    if (starting || running) return;
    setStarting(true);
    props.onError(undefined);
    try {
      await window.consensus.startCliSignIn(props.kind);
    } catch (error) {
      props.onError(cleanError(error, `Could not start ${props.label} sign-in.`));
    } finally {
      setStarting(false);
    }
  }

  async function cancel(): Promise<void> {
    if (!signIn || cancelling) return;
    setCancelling(true);
    try {
      await window.consensus.cancelCliSignIn(signIn.requestId);
    } catch (error) {
      setCancelling(false);
      props.onError(cleanError(error, "Could not cancel the sign-in."));
    }
  }

  function openPage(): void {
    if (!signIn?.pageUrl) return;
    if (signIn.pageGivesCode) setCodeFieldFor(signIn.requestId);
    void window.consensus.openExternal(signIn.pageUrl).catch(() => props.onError("Could not open the sign-in page."));
  }

  async function submitCode(): Promise<void> {
    if (!signIn || !code.trim() || signIn.status !== "waiting") return;
    setCodeError(undefined);
    try {
      await window.consensus.submitCliSignInCode({ requestId: signIn.requestId, code });
      setCode("");
    } catch (error) {
      setCodeError(cleanError(error, "Claude did not take the code."));
    }
  }

  if (!running || !signIn) {
    return (
      <div className="cli-sign-in" data-testid={`cli-sign-in-${props.kind}`}>
        <button
          type="button"
          className="cli-readiness-settings-action"
          disabled={starting || props.checkingAfterSignIn}
          onClick={() => void start()}
        >
          <LogIn size={15} aria-hidden /> {signIn?.status === "failed" ? "Sign in again" : "Sign in"}
        </button>
        {signIn?.status === "failed" && signIn.message && <p className="inline-error cli-sign-in-error" role="alert">{signIn.message}</p>}
        {props.checkingAfterSignIn && <p role="status">Signed in. Checking {props.label}…</p>}
      </div>
    );
  }

  return (
    <div className="cli-sign-in is-running" data-testid={`cli-sign-in-${props.kind}`}>
      <div className="cli-sign-in-row">
        <button
          type="button"
          className="cli-readiness-settings-action"
          disabled={cancelling}
          onClick={() => void cancel()}
        >
          <X size={15} aria-hidden /> Cancel
        </button>
        <p role="status">
          {cancelling
            ? "Cancelling sign-in…"
            : signIn.status === "starting"
              ? `Starting ${props.label} sign-in…`
              : signIn.status === "checking-code"
                ? "Checking the code…"
                : "Finish signing in with your browser."}
        </p>
      </div>
      {signIn.pageUrl && (
        <p className="cli-sign-in-hint">
          {showCodeField ? "Closed the page? " : "Browser didn't open? "}
          <button type="button" className="cli-sign-in-link" onClick={openPage}>
            {showCodeField ? "Open it again" : "Open the sign-in page"}
          </button>
        </p>
      )}
      {showCodeField && (
        <form className="cli-sign-in-code" onSubmit={(event) => { event.preventDefault(); void submitCode(); }}>
          <label>
            <span>Paste the code from the Claude page</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              maxLength={4096}
              value={code}
              disabled={signIn.status !== "waiting" || cancelling}
              onChange={(event) => setCode(event.currentTarget.value)}
            />
          </label>
          <button
            type="submit"
            className="cli-readiness-settings-action"
            disabled={signIn.status !== "waiting" || cancelling || !code.trim()}
          >
            Complete sign-in
          </button>
          {codeError && <p className="inline-error cli-sign-in-error" role="alert">{codeError}</p>}
        </form>
      )}
    </div>
  );
}

function cleanError(error: unknown, fallback: string): string {
  return cleanIpcError(error ?? "").trim() || fallback;
}
