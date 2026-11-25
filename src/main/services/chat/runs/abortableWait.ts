/** Waits for `done`, or rejects when `signal` aborts first. */
export function abortableWait(done: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return done;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Chat run cancelled."));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("Chat run cancelled."));
    signal.addEventListener("abort", onAbort, { once: true });
    done.then(() => { signal.removeEventListener("abort", onAbort); resolve(); }, (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); });
  });
}
