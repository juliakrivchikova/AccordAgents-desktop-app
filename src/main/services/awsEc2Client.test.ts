import assert from "node:assert/strict";
import test from "node:test";
import type { Instance } from "@aws-sdk/client-ec2";

import { awsWorkerInstanceInfoFromSdkInstance } from "./awsEc2Client";

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
