import { useCallback, useRef, useState } from "react";

export function useSubmittingIdSet(): {
  submittingIds: ReadonlySet<string>;
  resetSubmittingIds: () => void;
  runWithSubmittingId: (id: string, task: () => Promise<void>) => Promise<void>;
} {
  const submittingIdsRef = useRef<Set<string>>(new Set<string>());
  const [submittingIds, setSubmittingIds] = useState<ReadonlySet<string>>(new Set<string>());

  const resetSubmittingIds = useCallback(() => {
    submittingIdsRef.current.clear();
    setSubmittingIds(new Set<string>());
  }, []);

  const runWithSubmittingId = useCallback(async (id: string, task: () => Promise<void>) => {
    if (submittingIdsRef.current.has(id)) {
      return;
    }
    submittingIdsRef.current.add(id);
    setSubmittingIds(new Set(submittingIdsRef.current));
    try {
      await task();
    } finally {
      submittingIdsRef.current.delete(id);
      setSubmittingIds(new Set(submittingIdsRef.current));
    }
  }, []);

  return { submittingIds, resetSubmittingIds, runWithSubmittingId };
}
