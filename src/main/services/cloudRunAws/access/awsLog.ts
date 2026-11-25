import type { AwsDependencies } from "../dependencies";

/** The debug log. */
export class AwsLog {
  constructor(private readonly deps: Pick<AwsDependencies, "logger">) {}

  log(event: string, payload: Record<string, unknown>): void {
    this.deps.logger?.(event, payload);
  }
}
