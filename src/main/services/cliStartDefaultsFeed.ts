import type { CliStartDefaultsByKind } from "../../shared/cliStartDefaults";

/**
 * A machine's CLIs' start defaults for its hello (src/shared/cliStartDefaults.ts):
 * what was last read is said at once (reading takes the CLIs a few seconds),
 * read again in the background once it is older than `freshMs`, and a read
 * that changes what the last hello said asks for another hello.
 */
export class CliStartDefaultsFeed {
  private value?: CliStartDefaultsByKind;
  private readAt = 0;
  private reading?: Promise<void>;
  private said?: string;

  constructor(
    private readonly read: () => Promise<CliStartDefaultsByKind | undefined>,
    private readonly freshMs = 5 * 60_000,
    private readonly now: () => number = Date.now
  ) {}

  /** What a hello says now; `changed` is called once a background read
   *  changes it (for another hello), `failed` when a read fails. */
  take(changed: () => void, failed?: (error: unknown) => void): CliStartDefaultsByKind | undefined {
    this.refresh(changed, failed);
    this.said = JSON.stringify(this.value ?? null);
    return this.value;
  }

  /** The read in progress, if any (tests). */
  settled(): Promise<void> {
    return this.reading ?? Promise.resolve();
  }

  private refresh(changed: () => void, failed?: (error: unknown) => void): void {
    if (this.reading || (this.readAt > 0 && this.now() - this.readAt < this.freshMs)) return;
    this.reading = this.read()
      .then((value) => {
        this.value = value;
        this.readAt = this.now();
        if (JSON.stringify(value ?? null) !== this.said) changed();
      }, (error: unknown) => {
        this.readAt = this.now();
        failed?.(error);
      })
      .finally(() => { this.reading = undefined; });
  }
}
