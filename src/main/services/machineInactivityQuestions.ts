/**
 * The questions about machines that stopped being used, while they wait for
 * the User (the window's notice stack). Each is settled exactly once: by her
 * answer, by the machine connecting again ("active"), or by the machine being
 * removed some other way ("remove": AWS removing it, the relay's cleanup,
 * Settings).
 */

import type { MachineInactivityQuestion } from "../../shared/machineLink";
import type { MachineInactivityOutcome } from "./machineInactivity";

interface Entry {
  question: MachineInactivityQuestion;
  resolve: (outcome: MachineInactivityOutcome) => void;
  answering?: boolean;
  /** Settled while she was answering: used if her answer does not settle it. */
  settledDuring?: "active" | "remove";
}

export class MachineInactivityQuestions {
  private readonly entries = new Map<string, Entry>();

  /** `onChanged` gets the questions still waiting, after every change. */
  constructor(private readonly onChanged: (questions: MachineInactivityQuestion[]) => void) {}

  list(): MachineInactivityQuestion[] {
    return [...this.entries.values()].map((entry) => entry.question);
  }

  ask(question: MachineInactivityQuestion): Promise<MachineInactivityOutcome> {
    return new Promise((resolve) => {
      this.entries.get(question.machineId)?.resolve("active");
      this.entries.set(question.machineId, { question, resolve });
      this.onChanged(this.list());
    });
  }

  /** Settled without her answer: the machine connected again, or it was
   *  removed. One she is answering right now is left to her answer. */
  settle(machineId: string, outcome: "active" | "remove"): void {
    const entry = this.entries.get(machineId);
    if (!entry) return;
    if (entry.answering) {
      entry.settledDuring = outcome;
      return;
    }
    this.entries.delete(machineId);
    entry.resolve(outcome);
    this.onChanged(this.list());
  }

  /** Her answer. Removing is carried out before the question goes: when it
   *  fails, the error reaches the window and the question stays. */
  async answer(machineId: string, answer: "keep" | "remove", remove: (machineId: string) => Promise<unknown>): Promise<void> {
    const entry = this.entries.get(machineId);
    if (!entry || entry.answering) return;
    entry.answering = true;
    try {
      if (answer === "remove") await remove(machineId);
    } catch (error) {
      // The removal failed after the machine was already taken off (or it
      // came back meanwhile): the question goes with what settled it.
      if (entry.settledDuring) {
        this.entries.delete(machineId);
        entry.resolve(entry.settledDuring);
        this.onChanged(this.list());
      }
      throw error;
    } finally {
      entry.answering = false;
    }
    this.entries.delete(machineId);
    entry.resolve(answer);
    this.onChanged(this.list());
  }
}
