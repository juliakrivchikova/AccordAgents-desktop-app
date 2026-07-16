// Real EC2 client + host-side helpers for the AWS-managed worker. Kept apart
// from awsWorkerLifecycle.ts so the lifecycle state machine stays SDK-free and
// unit-testable; this module is the thin adapter over @aws-sdk/client-ec2 and
// the local key/IP tooling.
import { app } from "electron";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import {
  EC2Client,
  DescribeImagesCommand,
  DescribeRegionsCommand,
  DescribeVolumesCommand,
  DescribeVolumesModificationsCommand,
  DescribeInstanceTypesCommand,
  ModifyVolumeCommand,
  ImportKeyPairCommand,
  DescribeKeyPairsCommand,
  DeleteKeyPairCommand,
  CreateSecurityGroupCommand,
  DescribeSecurityGroupsCommand,
  DeleteSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand,
  RevokeSecurityGroupIngressCommand,
  RunInstancesCommand,
  DescribeInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  TerminateInstancesCommand,
  type Instance,
  type DescribeVolumesCommandOutput
} from "@aws-sdk/client-ec2";
import {
  EC2InstanceConnectClient,
  SendSSHPublicKeyCommand
} from "@aws-sdk/client-ec2-instance-connect";
import {
  AWS_WORKER_TAG_KEY,
  AWS_WORKER_TAG_VALUE,
  buildWorkerInstanceSpec
} from "./awsWorkerProvisioning";
import {
  awsWorkerKeyDir,
  awsWorkerPrivateKeyPath,
  deleteAwsWorkerKeyMaterial,
  generateOrLoadAwsWorkerKeyMaterial
} from "./awsWorkerKeyMaterial";
import type { AwsWorkerCredentials } from "./awsWorkerProvisioning";
import type {
  AwsWorkerImageInfo,
  AwsWorkerInstanceInfo,
  AwsWorkerInstanceState,
  AwsWorkerKeyMaterial,
  Ec2Client
} from "./awsWorkerLifecycle";

export function createAwsEc2Client(credentials: AwsWorkerCredentials): Ec2Client {
  const config = {
    region: credentials.region,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 5_000,
      requestTimeout: 15_000
    }),
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey
    }
  };
  return new SdkEc2Client(new EC2Client(config), new EC2InstanceConnectClient(config), credentials.region);
}

export function isAwsAuthorizationError(error: unknown): boolean {
  const record = error && typeof error === "object"
    ? error as { name?: unknown; Code?: unknown; code?: unknown; message?: unknown }
    : undefined;
  const identifiers = [record?.name, record?.Code, record?.code]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());
  if (identifiers.some((value) => value === "unauthorizedoperation"
    || value === "accessdenied"
    || value === "accessdeniedexception")) {
    return true;
  }
  const message = error instanceof Error
    ? error.message
    : typeof record?.message === "string"
      ? record.message
      : String(error ?? "");
  return /UnauthorizedOperation|AccessDenied|access denied|not authorized to perform|no identity-based policy allows/i.test(message);
}

export class SdkEc2Client implements Ec2Client {
  constructor(
    private readonly client: EC2Client,
    private readonly instanceConnect: EC2InstanceConnectClient,
    private readonly region: string
  ) {}

  async listEnabledRegions(): Promise<string[]> {
    const result = await this.client.send(new DescribeRegionsCommand({ AllRegions: false }));
    return (result.Regions ?? [])
      .map((entry) => entry.RegionName?.trim())
      .filter((entry): entry is string => Boolean(entry));
  }

  async findWorkerInstances(): Promise<AwsWorkerInstanceInfo[]> {
    const instances: AwsWorkerInstanceInfo[] = [];
    let nextToken: string | undefined;
    do {
      const result = await this.client.send(new DescribeInstancesCommand({
        Filters: [
          { Name: `tag:${AWS_WORKER_TAG_KEY}`, Values: [AWS_WORKER_TAG_VALUE] },
          { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped", "shutting-down"] }
        ],
        NextToken: nextToken
      }));
      for (const reservation of result.Reservations ?? []) {
        for (const instance of reservation.Instances ?? []) {
          const mapped = await this.mapInstance(instance);
          if (mapped) instances.push(mapped);
        }
      }
      nextToken = result.NextToken;
    } while (nextToken);
    return instances;
  }

  async resolveUbuntuImage(namePattern: string, owner: string): Promise<AwsWorkerImageInfo> {
    const result = await this.client.send(new DescribeImagesCommand({
      Owners: [owner],
      Filters: [
        { Name: "name", Values: [namePattern] },
        { Name: "state", Values: ["available"] },
        { Name: "architecture", Values: ["x86_64"] }
      ]
    }));
    const images = (result.Images ?? []).filter((image) => image.ImageId && image.CreationDate);
    images.sort((a, b) => (b.CreationDate ?? "").localeCompare(a.CreationDate ?? ""));
    const image = images[0];
    const imageId = image?.ImageId;
    if (!imageId) {
      throw new Error("Could not find an Ubuntu 24.04 AMI in this region.");
    }
    const rootDeviceName = image.RootDeviceName?.trim();
    if (!rootDeviceName) {
      throw new Error("Could not determine the Ubuntu AMI root device in this region.");
    }
    return { imageId, rootDeviceName };
  }

  async describeInstanceType(instanceType: string): Promise<{ vCpu: number; memoryMiB: number } | undefined> {
    const result = await this.client.send(new DescribeInstanceTypesCommand({ InstanceTypes: [instanceType as never] }));
    const info = result.InstanceTypes?.[0];
    const vCpu = info?.VCpuInfo?.DefaultVCpus;
    const memoryMiB = info?.MemoryInfo?.SizeInMiB;
    return typeof vCpu === "number" && typeof memoryMiB === "number"
      ? { vCpu, memoryMiB }
      : undefined;
  }

  async keyPairExists(name: string): Promise<boolean> {
    try {
      const result = await this.client.send(new DescribeKeyPairsCommand({ KeyNames: [name] }));
      return (result.KeyPairs ?? []).length > 0;
    } catch (error) {
      if (isAwsError(error, "InvalidKeyPair.NotFound")) {
        return false;
      }
      throw error;
    }
  }

  async importKeyPair(name: string, publicKeyMaterial: string): Promise<void> {
    await this.client.send(new ImportKeyPairCommand({
      KeyName: name,
      PublicKeyMaterial: Buffer.from(publicKeyMaterial, "utf8"),
      TagSpecifications: [{
        ResourceType: "key-pair",
        Tags: workerTags(name)
      }]
    }));
  }

  async deleteKeyPair(name: string): Promise<void> {
    try {
      await this.client.send(new DeleteKeyPairCommand({ KeyName: name }));
    } catch (error) {
      if (!isAwsError(error, "InvalidKeyPair.NotFound")) {
        throw error;
      }
    }
  }

  async ensureSecurityGroup(name: string, description: string): Promise<string> {
    const existing = await this.client.send(new DescribeSecurityGroupsCommand({
      Filters: [{ Name: "group-name", Values: [name] }]
    }));
    const found = existing.SecurityGroups?.[0]?.GroupId;
    if (found) {
      return found;
    }
    const created = await this.client.send(new CreateSecurityGroupCommand({
      GroupName: name,
      Description: description,
      TagSpecifications: [{
        ResourceType: "security-group",
        Tags: workerTags(name)
      }]
    }));
    if (!created.GroupId) {
      throw new Error("Failed to create the worker security group.");
    }
    return created.GroupId;
  }

  async deleteSecurityGroup(securityGroupId: string): Promise<void> {
    try {
      await this.client.send(new DeleteSecurityGroupCommand({ GroupId: securityGroupId }));
    } catch (error) {
      if (!isAwsError(error, "InvalidGroup.NotFound")) {
        throw error;
      }
    }
  }

  async authorizeSshIngress(securityGroupId: string, cidr: string): Promise<void> {
    try {
      await this.client.send(new AuthorizeSecurityGroupIngressCommand({
        GroupId: securityGroupId,
        IpPermissions: [sshPermission(cidr)]
      }));
    } catch (error) {
      // Idempotent: an identical rule already present is not an error.
      if (!isDuplicatePermission(error)) {
        throw error;
      }
    }
  }

  async revokeAllSshIngress(securityGroupId: string): Promise<void> {
    const describe = await this.client.send(new DescribeSecurityGroupsCommand({ GroupIds: [securityGroupId] }));
    const permissions = describe.SecurityGroups?.[0]?.IpPermissions ?? [];
    const sshRules = permissions.filter((permission) => permission.FromPort === 22 && permission.ToPort === 22);
    if (sshRules.length === 0) {
      return;
    }
    await this.client.send(new RevokeSecurityGroupIngressCommand({
      GroupId: securityGroupId,
      IpPermissions: sshRules
    }));
  }

  async replaceDeviceSshIngress(securityGroupId: string, cidr: string, deviceId: string): Promise<void> {
    const description = deviceIngressDescription(deviceId);
    const describe = await this.client.send(new DescribeSecurityGroupsCommand({ GroupIds: [securityGroupId] }));
    const permissions = describe.SecurityGroups?.[0]?.IpPermissions ?? [];
    const ownRanges = permissions
      .filter((permission) => permission.FromPort === 22 && permission.ToPort === 22)
      .flatMap((permission) => (permission.IpRanges ?? [])
        .filter((range) => range.Description === description && range.CidrIp && range.CidrIp !== cidr)
        .map((range) => ({ CidrIp: range.CidrIp, Description: range.Description })));
    if (ownRanges.length > 0) {
      await this.client.send(new RevokeSecurityGroupIngressCommand({
        GroupId: securityGroupId,
        IpPermissions: [{ IpProtocol: "tcp", FromPort: 22, ToPort: 22, IpRanges: ownRanges }]
      }));
    }
    try {
      await this.client.send(new AuthorizeSecurityGroupIngressCommand({
        GroupId: securityGroupId,
        IpPermissions: [{
          IpProtocol: "tcp",
          FromPort: 22,
          ToPort: 22,
          IpRanges: [{ CidrIp: cidr, Description: description }]
        }]
      }));
    } catch (error) {
      if (!isDuplicatePermission(error)) throw error;
    }
  }

  async runInstance(spec: ReturnType<typeof buildWorkerInstanceSpec>): Promise<string> {
    const result = await this.client.send(new RunInstancesCommand({
      ImageId: spec.imageId,
      InstanceType: spec.instanceType as never,
      KeyName: spec.keyName,
      SecurityGroupIds: [spec.securityGroupId],
      MinCount: 1,
      MaxCount: 1,
      ClientToken: spec.clientToken,
      UserData: spec.userData,
      BlockDeviceMappings: [{
        DeviceName: spec.rootDeviceName,
        Ebs: {
          DeleteOnTermination: true,
          VolumeSize: spec.rootVolumeSizeGb,
          VolumeType: "gp3"
        }
      }],
      TagSpecifications: [{
        ResourceType: "instance",
        Tags: [
          { Key: spec.tagKey, Value: spec.tagValue },
          { Key: "Name", Value: spec.keyName }
        ]
      }, {
        ResourceType: "volume",
        Tags: workerTags(spec.keyName)
      }]
    }));
    const instanceId = result.Instances?.[0]?.InstanceId;
    if (!instanceId) {
      throw new Error("RunInstances did not return an instance id.");
    }
    return instanceId;
  }

  async describeInstance(instanceId: string): Promise<AwsWorkerInstanceInfo | undefined> {
    try {
      const result = await this.client.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
      const instance = result.Reservations?.[0]?.Instances?.[0];
      return instance ? this.mapInstance(instance) : undefined;
    } catch (error) {
      if (isAwsError(error, "InvalidInstanceID.NotFound")) return undefined;
      throw error;
    }
  }

  async sendSshPublicKey(instanceId: string, availabilityZone: string, osUser: string, publicKey: string): Promise<void> {
    const result = await this.instanceConnect.send(new SendSSHPublicKeyCommand({
      InstanceId: instanceId,
      AvailabilityZone: availabilityZone,
      InstanceOSUser: osUser,
      SSHPublicKey: publicKey
    }));
    if (!result.Success) {
      throw new Error("EC2 Instance Connect did not accept this device key.");
    }
  }

  async modifyVolumeSize(volumeId: string, sizeGb: number): Promise<void> {
    await this.client.send(new ModifyVolumeCommand({ VolumeId: volumeId, Size: sizeGb }));
  }

  async describeVolumeModification(volumeId: string): Promise<"modifying" | "optimizing" | "completed" | "failed" | undefined> {
    const result = await this.client.send(new DescribeVolumesModificationsCommand({ VolumeIds: [volumeId] }));
    const state = result.VolumesModifications?.[0]?.ModificationState;
    return state === "modifying" || state === "optimizing" || state === "completed" || state === "failed"
      ? state
      : undefined;
  }

  async startInstance(instanceId: string): Promise<void> {
    await this.client.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
  }

  async stopInstance(instanceId: string): Promise<void> {
    await this.client.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
  }

  async terminateInstance(instanceId: string): Promise<void> {
    await this.client.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
  }

  private async mapInstance(instance: Instance): Promise<AwsWorkerInstanceInfo | undefined> {
    const base = awsWorkerInstanceInfoFromSdkInstance(instance);
    if (!base) return undefined;
    const rootVolumeId = base.rootVolumeId;
    const groupIds = (instance.SecurityGroups ?? [])
      .map((group) => group.GroupId)
      .filter((groupId): groupId is string => Boolean(groupId));
    const [volumeResult, typeInfo, groupResult] = await Promise.all([
      rootVolumeId
        ? this.describeVolume(rootVolumeId)
        : Promise.resolve(undefined),
      instance.InstanceType ? this.describeInstanceType(instance.InstanceType) : Promise.resolve(undefined),
      groupIds.length > 0
        ? this.client.send(new DescribeSecurityGroupsCommand({ GroupIds: groupIds }))
        : Promise.resolve(undefined)
    ]);
    const securityGroupId = groupResult?.SecurityGroups?.find((group) =>
      group.Tags?.some((tag) => tag.Key === AWS_WORKER_TAG_KEY && tag.Value === AWS_WORKER_TAG_VALUE))?.GroupId;
    return {
      ...base,
      region: this.region,
      availabilityZone: instance.Placement?.AvailabilityZone,
      instanceType: instance.InstanceType,
      vCpu: typeInfo?.vCpu,
      memoryMiB: typeInfo?.memoryMiB,
      rootVolumeId,
      rootVolumeSizeGb: volumeResult?.Volumes?.[0]?.Size,
      securityGroupId,
      keyName: instance.KeyName,
      launchedAt: instance.LaunchTime?.toISOString()
    };
  }

  private async describeVolume(volumeId: string): Promise<DescribeVolumesCommandOutput | undefined> {
    try {
      return await this.client.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }));
    } catch (error) {
      if (isAwsError(error, "InvalidVolume.NotFound")) return undefined;
      throw error;
    }
  }
}

export function awsWorkerInstanceInfoFromSdkInstance(instance: Instance | undefined): AwsWorkerInstanceInfo | undefined {
  if (!instance?.InstanceId) {
    return undefined;
  }
  const rootDeviceName = instance.RootDeviceName;
  const rootMapping = instance.BlockDeviceMappings?.find((mapping) =>
    mapping.DeviceName === rootDeviceName
  );
  const rootVolumeBackedByEbs = instance.RootDeviceType === "ebs"
    ? true
    : instance.RootDeviceType === "instance-store"
      ? false
      : undefined;
  return {
    instanceId: instance.InstanceId,
    state: mapInstanceState(instance.State?.Name),
    publicIp: instance.PublicIpAddress,
    rootDeviceName,
    rootVolumeId: rootMapping?.Ebs?.VolumeId,
    rootVolumeBackedByEbs
  };
}

function sshPermission(cidr: string): {
  IpProtocol: string;
  FromPort: number;
  ToPort: number;
  IpRanges: Array<{ CidrIp: string; Description: string }>;
} {
  return {
    IpProtocol: "tcp",
    FromPort: 22,
    ToPort: 22,
    IpRanges: [{ CidrIp: cidr, Description: "AccordAgents desktop" }]
  };
}

function isDuplicatePermission(error: unknown): boolean {
  const name = (error as { name?: string })?.name ?? "";
  return name === "InvalidPermission.Duplicate";
}

function isAwsError(error: unknown, name: string): boolean {
  return (error as { name?: string })?.name === name;
}

function workerTags(name: string): Array<{ Key: string; Value: string }> {
  return [
    { Key: AWS_WORKER_TAG_KEY, Value: AWS_WORKER_TAG_VALUE },
    { Key: "Name", Value: name }
  ];
}

function deviceIngressDescription(deviceId: string): string {
  const safe = deviceId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
  return `AccordAgents device ${safe}`;
}

function mapInstanceState(name: string | undefined): AwsWorkerInstanceState {
  switch (name) {
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "stopping":
    case "shutting-down":
      return "stopping";
    case "stopped":
      return "stopped";
    case "terminated":
      return "terminated";
    default:
      return "absent";
  }
}

// App-generated SSH keypair, so the user never manages a key file. Generated
// with ssh-keygen (already required for remote runs) into userData; the public
// half is imported to EC2, the private half stays local and drives SSH.
export async function generateAwsWorkerKeyMaterial(options: { rotate?: boolean } = {}): Promise<AwsWorkerKeyMaterial> {
  return generateOrLoadAwsWorkerKeyMaterial({
    keyDir: awsWorkerKeyDir(app.getPath("userData")),
    rotate: options.rotate
  });
}

export async function deleteGeneratedAwsWorkerKeyMaterial(keyName: string): Promise<void> {
  await deleteAwsWorkerKeyMaterial(awsWorkerKeyDir(app.getPath("userData")), keyName);
}

export function resolveAwsWorkerPrivateKeyPath(keyName: string): string {
  return awsWorkerPrivateKeyPath(awsWorkerKeyDir(app.getPath("userData")), keyName);
}

export async function resolveCurrentPublicIp(): Promise<string> {
  const sources = ["https://checkip.amazonaws.com", "https://api.ipify.org"];
  for (const url of sources) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      const text = (await response.text()).trim();
      if (/^(\d{1,3}\.){3}\d{1,3}$/.test(text)) {
        return text;
      }
    } catch {
      // try the next source
    }
  }
  throw new Error("Could not determine this machine's public IP address.");
}
