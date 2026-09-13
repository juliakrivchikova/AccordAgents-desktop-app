import { useEffect, useState } from "react";
import type { ReviewProgress } from "../../../shared/types";
import { AppLoadingState } from "../loading-states";

export function ChatCreationState({ progress, stopping }: { progress?: ReviewProgress; stopping: boolean }): JSX.Element {
  const [startedAt] = useState(Date.now);
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const message = stopping ? "Stopping preparation…" : progress?.message ?? "Creating your chat…";
  return <AppLoadingState title={stopping ? "Stopping" : "Starting chat"}
    description={<>{message}<span aria-hidden="true"> · {seconds}s</span></>} />;
}
