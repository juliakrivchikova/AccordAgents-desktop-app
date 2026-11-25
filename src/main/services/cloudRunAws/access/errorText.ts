import type { MachineRecoveryFailure } from "../../machineRecovery";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const MACHINE_DOWN_EFFECT = "Until it is, cloud members don't run and the instance does not stop by itself.";

/** What the Connection row says when the program on the cloud machine is not back. */
export function machineRecoveryMessage(failure: MachineRecoveryFailure): string {
  const reason = failure.reason ? ` ${plainReason(failure.reason)}` : "";
  switch (failure.kind) {
    case "check":
      return `The AccordAgents program on the cloud machine is out of touch, and the app could not reach the machine to check it.${reason} `
        + `It tries again by itself. ${MACHINE_DOWN_EFFECT}`;
    case "setup":
      return `The AccordAgents program on the cloud machine is not running, and the app could not start it again.${reason} `
        + `It tries again by itself. ${MACHINE_DOWN_EFFECT}`;
    case "agents":
      return "The AccordAgents program on the cloud machine is not running, but agents it started are still running there. "
        + `The app starts it again once they finish. ${MACHINE_DOWN_EFFECT}`;
    case "running":
      return "The AccordAgents program on the cloud machine is running, but this computer has not heard from it for over half an hour. "
        + "Cloud members wait until it does.";
  }
}

/** The first line of a failure, as one sentence of reasonable length. */
export function plainReason(reason: string): string {
  const line = reason.split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? "";
  const short = line.length > 200 ? `${line.slice(0, 197)}…` : line;
  return !short || /[.!?…]$/.test(short) ? short : `${short}.`;
}
