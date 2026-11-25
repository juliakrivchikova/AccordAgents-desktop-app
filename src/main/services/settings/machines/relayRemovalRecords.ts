/** What was set up through the shared relay and taken off this desktop when
 *  the relay went away (names only); its presence means the removal ran. */
export interface RelayRemovalRecord {
  removedAt: string;
  machines: string[];
  phones: string[];
  /** A phone paired through the relay was handed the key that starts the AWS
   *  machine; it keeps its copy until the key is replaced in AWS. */
  startKeyHanded: boolean;
  /** Kept from versions that showed the removal in Settings; unused. */
  dismissedAt?: string;
}

export function isRelayRemovalRecord(value: unknown): value is RelayRemovalRecord {
  const record = value as Partial<RelayRemovalRecord> | undefined;
  return Boolean(record) && typeof record!.removedAt === "string" && Array.isArray(record!.machines) && Array.isArray(record!.phones)
    && record!.machines.every((name) => typeof name === "string") && record!.phones.every((name) => typeof name === "string")
    && typeof record!.startKeyHanded === "boolean" && (record!.dismissedAt === undefined || typeof record!.dismissedAt === "string");
}

/** A relay removal that has not finished: the machines it found. */
export interface RelayRemovalPending {
  machines: Array<{ id: string; name: string }>;
  startKeyHanded: boolean;
}

export function isRelayRemovalPending(value: unknown): value is RelayRemovalPending {
  const pending = value as { machines?: unknown; startKeyHanded?: unknown } | undefined;
  return Boolean(pending) && Array.isArray(pending!.machines)
    && pending!.machines.every((machine) => typeof machine?.id === "string" && typeof machine?.name === "string")
    && typeof pending!.startKeyHanded === "boolean";
}

/** A relay machine whose removal failed at the last start, and why. */
export interface RelayRemovalFailure {
  machineId: string;
  machine: string;
  message: string;
  /** When this machine first failed for this reason. */
  at: string;
  /** Kept from versions that showed the failure in Settings; unused. */
  dismissedMessages?: string[];
}

export function isRelayRemovalFailure(value: unknown): value is RelayRemovalFailure {
  const failure = value as Partial<RelayRemovalFailure> | undefined;
  return Boolean(failure) && typeof failure!.machineId === "string" && typeof failure!.machine === "string"
    && typeof failure!.message === "string" && typeof failure!.at === "string"
    && (failure!.dismissedMessages === undefined || (Array.isArray(failure!.dismissedMessages) && failure!.dismissedMessages.every((message) => typeof message === "string")));
}
