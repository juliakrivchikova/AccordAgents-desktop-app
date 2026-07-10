import assert from "node:assert/strict";
import test from "node:test";
import type { EC2Client, Instance } from "@aws-sdk/client-ec2";
import type { EC2InstanceConnectClient } from "@aws-sdk/client-ec2-instance-connect";

import { awsWorkerInstanceInfoFromSdkInstance, SdkEc2Client } from "./awsEc2Client";

test("EC2 instance mapping derives EBS state independently from block-device mappings", () => {
  const pendingEbs = awsWorkerInstanceInfoFromSdkInstance({
    InstanceId: "i-ebs-pending",
    State: { Name: "pending" },
    RootDeviceName: "/dev/sda1",
    RootDeviceType: "ebs"
  });
  assert.equal(pendingEbs?.rootVolumeBackedByEbs, true);
  assert.equal(pendingEbs?.rootVolumeId, undefined);

  const instanceStore = awsWorkerInstanceInfoFromSdkInstance({
    InstanceId: "i-instance-store",
    State: { Name: "running" },
    RootDeviceType: "instance-store"
  });
  assert.equal(instanceStore?.rootVolumeBackedByEbs, false);

  const unknown = awsWorkerInstanceInfoFromSdkInstance({
    InstanceId: "i-unknown",
    State: { Name: "pending" }
  });
  assert.equal(unknown?.rootVolumeBackedByEbs, undefined);

  const mappedEbs = awsWorkerInstanceInfoFromSdkInstance({
    InstanceId: "i-ebs-running",
    State: { Name: "running" },
    RootDeviceName: "/dev/sda1",
    RootDeviceType: "ebs",
    BlockDeviceMappings: [{
      DeviceName: "/dev/sda1",
      Ebs: { VolumeId: "vol-0123456789abcdef0" }
    }]
  });
  assert.equal(mappedEbs?.rootVolumeBackedByEbs, true);
  assert.equal(mappedEbs?.rootVolumeId, "vol-0123456789abcdef0");
});

test("EC2 instance mapping preserves unknown future root-device types", () => {
  const instance = {
    InstanceId: "i-future",
    State: { Name: "pending" },
    RootDeviceType: "future-storage"
  } as unknown as Instance;
  assert.equal(awsWorkerInstanceInfoFromSdkInstance(instance)?.rootVolumeBackedByEbs, undefined);
});

test("tag discovery includes shutting-down and selects only the app-tagged security group", async () => {
  let discoveryFilters: Array<{ Name?: string; Values?: string[] }> = [];
  const ec2 = fakeClient(async (command) => {
    switch (command.constructor.name) {
      case "DescribeInstancesCommand":
        discoveryFilters = command.input.Filters ?? [];
        return {
          Reservations: [{ Instances: [{
            InstanceId: "i-shared",
            State: { Name: "running" },
            PublicIpAddress: "198.51.100.8",
            RootDeviceName: "/dev/sda1",
            BlockDeviceMappings: [{ DeviceName: "/dev/sda1", Ebs: { VolumeId: "vol-root" } }],
            InstanceType: "t3.medium",
            Placement: { AvailabilityZone: "eu-west-1a" },
            SecurityGroups: [{ GroupId: "sg-foreign" }, { GroupId: "sg-app" }]
          }] }]
        };
      case "DescribeVolumesCommand":
        return { Volumes: [{ VolumeId: "vol-root", Size: 32 }] };
      case "DescribeInstanceTypesCommand":
        return { InstanceTypes: [{ VCpuInfo: { DefaultVCpus: 2 }, MemoryInfo: { SizeInMiB: 4096 } }] };
      case "DescribeSecurityGroupsCommand":
        return { SecurityGroups: [
          { GroupId: "sg-foreign", Tags: [{ Key: "Name", Value: "shared" }] },
          { GroupId: "sg-app", Tags: [{ Key: "accordagents-worker", Value: "1" }] }
        ] };
      default:
        throw new Error(`Unexpected ${command.constructor.name}`);
    }
  });
  const client = new SdkEc2Client(ec2 as EC2Client, fakeClient(async () => ({})) as EC2InstanceConnectClient, "eu-west-1");
  const workers = await client.findWorkerInstances();
  assert.ok(discoveryFilters.find((filter) => filter.Name === "instance-state-name")?.Values?.includes("shutting-down"));
  assert.equal(workers[0]?.securityGroupId, "sg-app");
  assert.equal(workers[0]?.rootVolumeSizeGb, 32);
  assert.equal(workers[0]?.memoryMiB, 4096);
});

test("describeInstance translates InvalidInstanceID.NotFound to absence", async () => {
  const ec2 = fakeClient(async () => {
    const error = new Error("missing");
    error.name = "InvalidInstanceID.NotFound";
    throw error;
  });
  const client = new SdkEc2Client(ec2 as EC2Client, fakeClient(async () => ({})) as EC2InstanceConnectClient, "us-east-1");
  assert.equal(await client.describeInstance("i-gone"), undefined);
});

test("device ingress replacement revokes only this device's stale rule", async () => {
  const calls: Array<{ name: string; input: any }> = [];
  const ec2 = fakeClient(async (command) => {
    calls.push({ name: command.constructor.name, input: command.input });
    if (command.constructor.name === "DescribeSecurityGroupsCommand") {
      return { SecurityGroups: [{ IpPermissions: [{
        FromPort: 22,
        ToPort: 22,
        IpRanges: [
          { CidrIp: "198.51.100.1/32", Description: "AccordAgents device device-a" },
          { CidrIp: "198.51.100.2/32", Description: "AccordAgents device device-b" }
        ]
      }] }] };
    }
    return {};
  });
  const client = new SdkEc2Client(ec2 as EC2Client, fakeClient(async () => ({})) as EC2InstanceConnectClient, "us-east-1");
  await client.replaceDeviceSshIngress("sg-app", "203.0.113.9/32", "device-a");
  const revoke = calls.find((call) => call.name === "RevokeSecurityGroupIngressCommand");
  assert.deepEqual(revoke?.input.IpPermissions[0].IpRanges, [
    { CidrIp: "198.51.100.1/32", Description: "AccordAgents device device-a" }
  ]);
});

function fakeClient(send: (command: any) => Promise<any>): { send: (command: any) => Promise<any> } {
  return { send };
}
