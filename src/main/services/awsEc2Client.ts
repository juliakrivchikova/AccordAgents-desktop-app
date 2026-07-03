// Real EC2 client + host-side helpers for the AWS-managed worker. Kept apart
// from awsWorkerLifecycle.ts so the lifecycle state machine stays SDK-free and
// unit-testable; this module is the thin adapter over @aws-sdk/client-ec2 and
// the local key/IP tooling.
import { app } from "electron";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import {
  EC2Client,
  DescribeImagesCommand,
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
  TerminateInstancesCommand
} from "@aws-sdk/client-ec2";
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
  AwsWorkerInstanceInfo,
  AwsWorkerInstanceState,
  AwsWorkerKeyMaterial,
  Ec2Client
} from "./awsWorkerLifecycle";

export function createAwsEc2Client(credentials: AwsWorkerCredentials): Ec2Client {
  const client = new EC2Client({
    region: credentials.region,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 5_000,
      requestTimeout: 15_000
    }),
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey
    }
  });
  return new SdkEc2Client(client);
}

class SdkEc2Client implements Ec2Client {
  constructor(private readonly client: EC2Client) {}

  async resolveUbuntuImageId(namePattern: string, owner: string): Promise<string> {
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
    const imageId = images[0]?.ImageId;
    if (!imageId) {
      throw new Error("Could not find an Ubuntu 24.04 AMI in this region.");
    }
    return imageId;
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

  async runInstance(spec: ReturnType<typeof buildWorkerInstanceSpec>): Promise<string> {
    const result = await this.client.send(new RunInstancesCommand({
      ImageId: spec.imageId,
      InstanceType: spec.instanceType as never,
      KeyName: spec.keyName,
      SecurityGroupIds: [spec.securityGroupId],
      MinCount: 1,
      MaxCount: 1,
      UserData: spec.userData,
      TagSpecifications: [{
        ResourceType: "instance",
        Tags: [
          { Key: spec.tagKey, Value: spec.tagValue },
          { Key: "Name", Value: spec.keyName }
        ]
      }]
    }));
    const instanceId = result.Instances?.[0]?.InstanceId;
    if (!instanceId) {
      throw new Error("RunInstances did not return an instance id.");
    }
    return instanceId;
  }

  async describeInstance(instanceId: string): Promise<AwsWorkerInstanceInfo | undefined> {
    const result = await this.client.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    const instance = result.Reservations?.[0]?.Instances?.[0];
    if (!instance?.InstanceId) {
      return undefined;
    }
    return {
      instanceId: instance.InstanceId,
      state: mapInstanceState(instance.State?.Name),
      publicIp: instance.PublicIpAddress
    };
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
