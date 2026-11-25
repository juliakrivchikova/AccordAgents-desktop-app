import type { AwsDependencies } from "../dependencies";
import type { AwsModules } from "../modules";

// The parts of the AWS service as its tests set them up and watch them: their
// private members too, so a test names the part that does the work.
type Open<T> = { -readonly [Key in keyof T]-?: any };

export function awsParts(service: unknown): Open<AwsModules> {
  return (service as { modules: Open<AwsModules> }).modules;
}

/** What that service was given; one object, shared by every part. */
export function awsDependencies(service: unknown): Open<AwsDependencies> {
  return awsParts(service).preparation.deps as Open<AwsDependencies>;
}
