import type { AwsDependencies } from "./dependencies";
import { AutoStop } from "./power/autoStop";
import { AwsLog } from "./access/awsLog";
import { Bootstrap } from "./setup/bootstrap";
import { DiskGrowth } from "./setup/diskGrowth";
import { Ec2Access } from "./access/ec2Access";
import { GoneInstances } from "./instances/goneInstances";
import { InstalledPrograms } from "./programs/installedPrograms";
import { InstanceRemoval } from "./instances/instanceRemoval";
import { LeavingMachines } from "./instances/leavingMachines";
import { Preparation } from "./setup/preparation";
import { WorkerRuns } from "./power/workerRuns";
import { WorkerStatus } from "./instances/workerStatus";

/** The AWS service's parts. Each names the ones it uses in its constructor. */
export interface AwsModules {
  readonly bootstrap: Bootstrap;
  readonly preparation: Preparation;
  readonly diskGrowth: DiskGrowth;
  readonly workerStatus: WorkerStatus;
  readonly goneInstances: GoneInstances;
  readonly leavingMachines: LeavingMachines;
  readonly instanceRemoval: InstanceRemoval;
  readonly autoStop: AutoStop;
  readonly workerRuns: WorkerRuns;
  readonly installedPrograms: InstalledPrograms;
  readonly ec2Access: Ec2Access;
  readonly awsLog: AwsLog;
}

/** Builds every part around one registry: parts call each other only once all of them exist. */
export function createAwsModules(deps: AwsDependencies): AwsModules {
  const modules = {} as { -readonly [Key in keyof AwsModules]: AwsModules[Key] };
  modules.bootstrap = new Bootstrap(modules, deps);
  modules.preparation = new Preparation(modules, deps);
  modules.diskGrowth = new DiskGrowth(modules, deps);
  modules.workerStatus = new WorkerStatus(modules, deps);
  modules.goneInstances = new GoneInstances(modules, deps);
  modules.leavingMachines = new LeavingMachines(modules, deps);
  modules.instanceRemoval = new InstanceRemoval(modules, deps);
  modules.autoStop = new AutoStop(modules, deps);
  modules.workerRuns = new WorkerRuns(modules, deps);
  modules.installedPrograms = new InstalledPrograms(deps);
  modules.ec2Access = new Ec2Access(modules, deps);
  modules.awsLog = new AwsLog(deps);
  return modules;
}
