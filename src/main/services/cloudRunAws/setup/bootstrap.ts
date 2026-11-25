import type { AwsWorkerStatus } from "../../../../shared/types";
import { buildBootstrapCommand, parseWorkerBlob } from "../../awsWorkerProvisioning";
import { withRetainedKeys } from "./workerSpec";
import type { AwsModules } from "../modules";
import type { AwsDependencies } from "../dependencies";

/** The AWS keys the User sets up with. */
export class Bootstrap {
  constructor(
    private readonly aws: Pick<AwsModules, "autoStop" | "ec2Access" | "installedPrograms" | "workerStatus">,
    private readonly deps: Pick<AwsDependencies, "platform" | "settings">
  ) {}

  async bootstrapCommand(region: string, recoveryOperationId?: string): Promise<string> {
    const deviceId = await this.deps.settings.getCloudRunsDeviceId();
    let targetUserName: string | undefined;
    if (recoveryOperationId !== undefined) {
      const operation = await this.deps.settings.getAwsWorkerOperation();
      if (operation?.operationId !== recoveryOperationId || operation.phase !== "error" || operation.remediation !== "refresh-aws-authorization") {
        throw new Error("That AWS permission error is no longer current. Try again first; update permissions only from a current error.");
      }
      targetUserName = operation.awsPrincipalUserName;
    }
    if (targetUserName) return buildBootstrapCommand(region, deviceId, { targetUserName }, this.deps.platform);
    // The stop and start keys belong to the instance's region: a command for
    // another region must not rewrite the policies of keys already in use.
    const handle = (await this.deps.settings.getPublicSettings()).cloudRuns.awsHandle;
    const otherRegion = Boolean(handle && handle.region !== region.trim());
    return buildBootstrapCommand(region, deviceId, { ...await this.keysInUse(), ...(otherRegion ? { machineKeys: false } : {}) }, this.deps.platform);
  }

  /** The keys a rerun of the setup command must leave valid: the app's own,
   *  the stop key it has not handed over yet, and the stop key each machine
   *  on its instance runs with. A read failure fails the command instead of
   *  producing one that could delete a key still in use. */
  private async keysInUse(): Promise<{ keepWorkerKeyId?: string; keepPowerKeyIds: string[]; keepWakeKeyId?: string }> {
    const credentials = await this.deps.settings.getAwsWorkerCredentials();
    const handle = (await this.deps.settings.getPublicSettings()).cloudRuns.awsHandle;
    const records = handle ? (await this.aws.installedPrograms.installsOnInstance(handle)).records : [];
    const held = records.flatMap((record) => record.power ? [record.power.keyId] : []);
    // A stop key a machine refused, and no machine holds, is not in use: the
    // rerun that sets automatic stop up again may replace it.
    const pending = credentials?.power?.accessKeyId;
    const refused = pending !== undefined && !held.includes(pending) && records.some((record) => record.powerError?.keyId === pending);
    return {
      keepWorkerKeyId: credentials?.accessKeyId,
      keepPowerKeyIds: [...(pending && !refused ? [pending] : []), ...held],
      keepWakeKeyId: credentials?.wake?.accessKeyId
    };
  }

  /** The status read with AWS's refusal left intact: a caller that must tell a
   *  revoked permission from a network failure needs the raw error. Reads only. */
  async probeAccess(): Promise<AwsWorkerStatus> {
    const context = await this.aws.workerStatus.workerContext();
    if (!context.credentials || !context.handle) return { configured: false, operation: context.operation };
    const { status } = await this.aws.workerStatus.describeWorker(context.credentials, context.handle, context.operation);
    return this.aws.workerStatus.withLeavingNotices(await this.aws.autoStop.withMachineState(context.credentials, context.handle, status));
  }

  /** Replace the saved credentials with pasted ones once they prove, read-only,
   *  that they can see the existing instance. Nothing else is touched. */
  async adoptCredentials(blob: string): Promise<void> {
    const credentials = withRetainedKeys(parseWorkerBlob(blob), await this.deps.settings.getAwsWorkerCredentials());
    const handle = (await this.deps.settings.getPublicSettings()).cloudRuns.awsHandle;
    if (!handle) throw new Error("Connect the AWS account before updating its credentials.");
    // The stop key only covers the region the command was run for.
    if (credentials.power && credentials.region !== handle.region) {
      throw new Error(`The setup command was run for ${credentials.region}, but the instance is in ${handle.region}. The pasted result was not used; run the command again with region ${handle.region}.`);
    }
    const info = await this.aws.ec2Access.clientForRegion(credentials, handle.region).describeInstance(handle.instanceId);
    if (!info || info.instanceId !== handle.instanceId) {
      throw new Error(`These credentials cannot see the existing instance ${handle.instanceId} in ${handle.region}. The saved credentials were kept.`);
    }
    await this.deps.settings.saveAwsWorkerCredentials(credentials);
  }
}
