/** Which instance the app removed by itself, and when: only that it
 *  happened is shown, the instance id is kept for the debug trail. */
export interface AwsWorkerGoneNotice {
  instanceId: string;
  at: string;
}

/** A machine whose instance can never come back, recorded before it is
 *  removed so that a removal cut short is finished later, also after a restart. */
export interface LeavingMachine {
  machineId: string;
  instanceId: string;
  at: string;
  /** Its instance could not be checked, because AWS refused the keys it was
   *  made with or this computer can no longer read them: never removed by
   *  the app, only shown. */
  unverified?: "refused" | "unreadable";
  /** Where to look at its instance again, and the AWS account it belongs to
   *  when known: only that account's keys prove by "no such instance" that
   *  it is gone. */
  region?: string;
  accountId?: string;
}

/** How many leaving machines are kept; one desktop has a handful. */
export const LEAVING_MACHINES_LIMIT = 50;

export function normalizeLeavingMachines(value: unknown, limit = LEAVING_MACHINES_LIMIT): LeavingMachine[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const text = (item: unknown): item is string => typeof item === "string" && item.trim().length > 0;
  const entries = value.filter((item): item is LeavingMachine => Boolean(item) && typeof item === "object"
    && text((item as LeavingMachine).machineId) && text((item as LeavingMachine).instanceId) && text((item as LeavingMachine).at))
    .map((item) => ({ machineId: item.machineId, instanceId: item.instanceId, at: item.at,
      ...(item.unverified === "refused" || item.unverified === "unreadable" ? { unverified: item.unverified } : {}),
      ...(text(item.region) ? { region: item.region } : {}),
      ...(typeof item.accountId === "string" && /^\d{12}$/.test(item.accountId) ? { accountId: item.accountId } : {}) }));
  return entries.length ? entries.slice(-limit) : undefined;
}

export function normalizeAwsWorkerGoneNotice(value: unknown): AwsWorkerGoneNotice | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Partial<AwsWorkerGoneNotice>;
  return typeof record.instanceId === "string" && record.instanceId.trim() && typeof record.at === "string" && record.at
    ? { instanceId: record.instanceId.trim(), at: record.at }
    : undefined;
}
