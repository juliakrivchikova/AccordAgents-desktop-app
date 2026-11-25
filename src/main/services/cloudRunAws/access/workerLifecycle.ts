import { userDataPath } from "../../../platform";
import { deleteGeneratedAwsWorkerKeyMaterial, resolveCurrentPublicIp, type generateAwsWorkerKeyMaterial } from "../../awsEc2Client";
import { awsWorkerKeyDir } from "../../awsWorkerKeyMaterial";
import { forgetLaunchHostKey, hostKeyForLaunch, pinWorkerHostKey } from "../../awsWorkerHostKeys";
import { AwsWorkerLifecycle, type Ec2Client } from "../../awsWorkerLifecycle";
import type { AwsWorkerCredentials } from "../../awsWorkerProvisioning";
import type { RemoteRunWorkerTarget } from "../../remoteWorkerTarget";
import type { SettingsService } from "../../settings";
import { WORKER_ROOT, WORKER_SSH_USER } from "../constants";
import type { AwsModules } from "../modules";
import type { CloudRunAwsServiceOptions } from "../types";

/** Starts, stops and replaces the instance; an idle stop asks the instance itself first. */
export function createWorkerLifecycle(given: {
  settings: SettingsService;
  options: CloudRunAwsServiceOptions;
  createEc2Client: (credentials: AwsWorkerCredentials) => Ec2Client;
  generateKeyMaterial: typeof generateAwsWorkerKeyMaterial;
  automaticStopOwnerId: string;
  parts: () => Pick<AwsModules, "autoStop" | "ec2Access">;
}): AwsWorkerLifecycle {
  const { settings, options, createEc2Client, generateKeyMaterial, automaticStopOwnerId, parts } = given;
  return new AwsWorkerLifecycle({
    createEc2Client,
    generateKeyMaterial,
    deleteKeyMaterial: async (keyName) => (options.deleteKeyMaterial ?? deleteGeneratedAwsWorkerKeyMaterial)(keyName),
    currentPublicIp: options.currentPublicIp ?? resolveCurrentPublicIp,
    hostKey: options.workerHostKey ?? {
      generate: (launchToken) => hostKeyForLaunch(awsWorkerKeyDir(userDataPath()), launchToken),
      pin: async (alias, publicKey, launchToken) => {
        await pinWorkerHostKey(awsWorkerKeyDir(userDataPath()), alias, publicKey);
        await forgetLaunchHostKey(awsWorkerKeyDir(userDataPath()), launchToken);
      }
    },
    // The User's switch governs this desktop's own idle stop too.
    automaticStopEnabled: () => parts().autoStop.autoStopSwitchedOn(),
    authorizeAutomaticStop: async (info) => {
      const gate = options.automaticStopGate;
      if (!gate || !info.publicIp) {
        return undefined;
      }
      const publicSettings = await settings.getPublicSettings();
      const handle = publicSettings.cloudRuns.awsHandle;
      if (!handle) {
        return undefined;
      }
      const worker: RemoteRunWorkerTarget = {
        host: info.publicIp,
        user: WORKER_SSH_USER,
        identityFile: parts().ec2Access.privateKeyPath(handle),
        hostKeyAlias: `accordagents-${info.instanceId}`,
        workerRoot: WORKER_ROOT
      };
      const authorization = await gate.authorizeAutomaticWorkerStop(worker, automaticStopOwnerId);
      if (!authorization.allowed || !authorization.lease) {
        return undefined;
      }
      let lease = authorization.lease;
      return {
        renew: async () => {
          lease = await gate.renewAutomaticWorkerStopLease(worker, lease);
        },
        release: async () => {
          await gate.releaseAutomaticWorkerStopLease(worker, lease);
        }
      };
    },
    idleStopMs: options.idleStopMs,
    idleStopRetryMs: options.idleStopRetryMs,
    logger: options.logger
  });
}
