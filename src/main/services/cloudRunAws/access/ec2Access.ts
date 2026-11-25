import type { AwsWorkerHandleInfo } from "../../../../shared/types";
import type { AwsWorkerCredentials } from "../../awsWorkerProvisioning";
import type { AwsWorkerHandle, AwsWorkerInstanceInfo, AwsWorkerKeyMaterial, Ec2Client } from "../../awsWorkerLifecycle";
import { isAwsAuthorizationError } from "../../awsEc2Client";
import { safeAwsErrorLogFields } from "./handles";
import { knownInstanceCapacity } from "../setup/workerSpec";
import type { AwsModules } from "../modules";
import type { AwsDependencies } from "../dependencies";

const AWS_AUTHORIZATION_RETRY_DELAYS_MS = [250, 1_000, 2_500] as const;

/** Reaches EC2 with the User's keys. */
export class Ec2Access {
  constructor(
    private readonly aws: Pick<AwsModules, "awsLog">,
    private readonly deps: Pick<AwsDependencies, "createEc2Client" | "generateKeyMaterial" | "privateKeyPathForKeyName" | "wait">
  ) {}

  async discoverWorkers(credentials: AwsWorkerCredentials, forceAll: boolean): Promise<AwsWorkerInstanceInfo[]> {
    const configured = this.deps.createEc2Client(credentials);
    if (!configured.findWorkerInstances) return [];
    const local = await this.withAuthorizationRetry(
      "find-worker-instances",
      () => configured.findWorkerInstances?.() ?? Promise.resolve([])
    );
    if (!forceAll && local.length > 0) return local;
    const regions = await this.listEnabledRegions(configured, credentials.region);
    const others = await Promise.all(regions
      .filter((region) => region !== credentials.region)
      .map((region) => {
        const regional = this.clientForRegion(credentials, region);
        return this.withAuthorizationRetry(
          "find-worker-instances",
          () => regional.findWorkerInstances?.() ?? Promise.resolve([])
        );
      }));
    return [...local, ...others.flat()];
  }

  private async listEnabledRegions(client: Ec2Client, fallbackRegion: string): Promise<string[]> {
    if (!client.listEnabledRegions) return [fallbackRegion];
    return this.withAuthorizationRetry("list-enabled-regions", () => client.listEnabledRegions?.() ?? Promise.resolve([fallbackRegion]));
  }

  private async withAuthorizationRetry<T>(operation: string, action: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await action();
      } catch (error) {
        const delayMs = AWS_AUTHORIZATION_RETRY_DELAYS_MS[attempt];
        if (!isAwsAuthorizationError(error) || delayMs === undefined) throw error;
        this.aws.awsLog.log("aws-worker.discovery.authorization-retry", {
          operation,
          attempt: attempt + 1,
          delayMs,
          ...safeAwsErrorLogFields(error)
        });
        await this.deps.wait(delayMs);
      }
    }
  }

  async capacityFor(credentials: AwsWorkerCredentials, instanceType: string): Promise<{ vCpu?: number; memoryMiB?: number }> {
    try {
      const described = await this.deps.createEc2Client(credentials).describeInstanceType?.(instanceType);
      if (described) return described;
    } catch (error) {
      if (!isAwsAuthorizationError(error)) throw error;
      this.aws.awsLog.log("aws-worker.capacity.authorization-fallback", {
        instanceType,
        ...safeAwsErrorLogFields(error)
      });
    }
    return knownInstanceCapacity(instanceType);
  }

  clientForRegion(credentials: AwsWorkerCredentials, region: string): Ec2Client {
    return this.deps.createEc2Client({ ...credentials, region });
  }

  toHandle(info: AwsWorkerHandleInfo): AwsWorkerHandle {
    return {
      instanceId: info.instanceId,
      securityGroupId: info.securityGroupId,
      keyName: info.accessKeyName ?? info.keyName,
      privateKeyPath: this.privateKeyPath(info),
      region: info.region
    };
  }

  async keyForHandle(handle: AwsWorkerHandleInfo): Promise<AwsWorkerKeyMaterial> {
    const key = await this.deps.generateKeyMaterial();
    if ((handle.accessKeyName ?? handle.keyName) === key.keyName) return key;
    return key;
  }

  privateKeyPath(info: AwsWorkerHandleInfo): string {
    return this.deps.privateKeyPathForKeyName(info.accessKeyName ?? info.keyName);
  }
}
