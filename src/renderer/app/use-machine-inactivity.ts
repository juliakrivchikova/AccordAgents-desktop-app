import * as React from "react";
import type { MachineInactivityQuestion } from "../../shared/machineLink";
import { errorText } from "../components/review/review-conversation-data";

/** Machines the User is asked about because they stopped being used: kept in
 *  the main process until answered, so a reload shows the same questions. */
export function useMachineInactivityQuestions(onError: (message: string) => void): {
  questions: MachineInactivityQuestion[];
  answer: (machineId: string, answer: "keep" | "remove") => void;
} {
  const [questions, setQuestions] = React.useState<MachineInactivityQuestion[]>([]);
  React.useEffect(() => {
    let active = true;
    void window.consensus.listMachineInactivityQuestions()
      .then((items) => { if (active) setQuestions(items); })
      .catch(() => undefined);
    const unsubscribe = window.consensus.onMachineInactivityQuestions((items) => setQuestions(items));
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  const answer = React.useCallback((machineId: string, value: "keep" | "remove") => {
    void window.consensus.answerMachineInactivity({ machineId, answer: value })
      .then(setQuestions)
      .catch((caught) => onError(errorText(caught)));
  }, [onError]);
  return { questions, answer };
}
