import { Fragment, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AWS_DISK_JOURNAL_KEEP_BYTES, AWS_WORKER_ROOT_VOLUME_SIZE_GB_MAX } from "../../../shared/cloudRuns";
import type { AwsDiskCategory, AwsDiskCategoryId, AwsDiskCleanCategory } from "../../../shared/types";
import { AwsDialog, AwsWaiting } from "./aws-dialog";
import { AwsDiskBrowser, type AwsDiskBrowseStart } from "./aws-disk-browser";
import { Row } from "./aws-row";
import { publishAwsAttention } from "./use-aws-attention";
import { AWS_DISK_LOW_BYTES, formatBytes, keptText, plural, useAwsDisk, type AwsDiskControl } from "./use-aws-disk";
import { cleanError } from "./aws-shared";
import type { AwsWorkerControl } from "./use-aws-worker-control";

interface CategoryText {
  label: string;
  tone: string;
  describe: (category: AwsDiskCategory) => string;
  clean?: AwsDiskCleanCategory;
  browse?: AwsDiskBrowseStart;
  /** The clean-up dialog's description. */
  cleans?: (category: AwsDiskCategory) => string;
}

const JOURNAL_KEEP = formatBytes(AWS_DISK_JOURNAL_KEEP_BYTES);


const CATEGORY: Record<AwsDiskCategoryId, CategoryText> = {
  "system": { label: "Operating system and tools", tone: "is-c2", describe: () => "Ubuntu, Node.js, git, Java and the rest the agents use" },
  "other-programs": { label: "Your other computers' programs", tone: "is-c1",
    describe: (c) => `${plural(c.count ?? 0, "program")}, installed and managed from those computers` },
  "cloud-runs": { label: "Cloud run working files", tone: "is-c3", browse: "@runs", describe: () => "Mailboxes, run records and older project copies" },
  "agent-tools": { label: "Agent tools", tone: "is-c4", describe: () => "Claude Code and Codex as the agents run them; old copies are removed by themselves" },
  "program-logs": { label: "Program logs", tone: "is-c5", clean: "program-logs",
    describe: (c) => c.cleanableBytes ? `${plural(c.files ?? 0, "day")} of logs. Clean up removes logs older than a day: ${formatBytes(c.cleanableBytes)}.` : `${plural(c.files ?? 0, "day")} of logs; nothing older than a day.`,
    cleans: (c) => `Removes the program's logs older than a day and frees ${formatBytes(c.cleanableBytes ?? 0)}. Today's log stays.` },
  "project-copies": { label: "Project copies", tone: "is-c6", browse: "@mirrors",
    describe: (c) => c.projects?.length ? `Copies of your projects: ${c.projects.map((name) => name.replace(/-[0-9a-f]{10}$/, "")).join(", ")}` : "Copies of your projects" },
  "program-data": { label: "Program data and sign-ins", tone: "is-c10", describe: () => "Chats, settings and the agents' sign-ins on the instance" },
  "caches": { label: "Caches", tone: "is-c9", clean: "caches",
    describe: (c) => c.cleanableBytes ? `npm, Electron and build caches. Clean up removes them: ${formatBytes(c.cleanableBytes)}.` : "npm, Electron and build caches",
    cleans: (c) => `Removes npm, Electron and build caches and frees ${formatBytes(c.cleanableBytes ?? 0)}. They download again when needed.` },
  "program-versions": { label: "Old program versions", tone: "is-c7", clean: "program-versions",
    describe: (c) => `${(c.count ?? 0)} kept, ${c.inUse ?? 0} in use.${c.cleanableBytes ? ` Clean up removes the ${Math.max(0, (c.count ?? 0) - (c.inUse ?? 0))} not in use: ${formatBytes(c.cleanableBytes)}.` : ""}`,
    cleans: (c) => `Removes the ${plural(Math.max(0, (c.count ?? 0) - (c.inUse ?? 0)), "program version")} not in use and frees ${formatBytes(c.cleanableBytes ?? 0)}. The running version stays.` },
  "system-logs": { label: "System logs", tone: "is-c8", clean: "system-logs",
    describe: (c) => c.cleanableBytes ? `Kept by Ubuntu. Clean up keeps the last ${JOURNAL_KEEP} and frees ${formatBytes(c.cleanableBytes)}.` : `Kept by Ubuntu, under ${JOURNAL_KEEP}`,
    cleans: (c) => `Removes Ubuntu's older system logs and frees ${formatBytes(c.cleanableBytes ?? 0)}. The last ${JOURNAL_KEEP} stay.` },
  "swap": { label: "Swap file", tone: "is-swap", describe: () => "Extra memory for the instance's RAM; the instance needs it" }
};

/**
 * What fills the instance's disk, measured on the instance: one bar, one row
 * per kind of thing with its own action (clean up or look inside), all the
 * files, and growing the disk.
 */
export function AwsDiskSection(props: { control: AwsWorkerControl }): JSX.Element {
  const c = props.control;
  const running = c.status?.state === "running";
  const disk = useAwsDisk(running);
  const [browse, setBrowse] = useState<AwsDiskBrowseStart>();
  const [cleaning, setCleaning] = useState<AwsDiskCategory>();
  const [growing, setGrowing] = useState(false);
  const size = c.actual?.rootVolumeSizeGb;
  const sizeRow = (
    <Row title={size ? `Disk size ${size} GiB` : "Disk size"} testId="aws-disk-size"
      desc="Grows in place; everything on it stays. AWS cannot make it smaller again."
      error={c.feedback?.failed && c.feedback.action === "resize" ? `The change failed: ${c.feedback.message}` : undefined}
      action={c.actual ? { label: "Grow disk…", onClick: () => setGrowing(true), disabled: c.locked, testId: "aws-disk-grow" } : undefined} />
  );
  const report = disk.report;
  const low = running && Boolean(report && report.availableBytes < AWS_DISK_LOW_BYTES);
  useEffect(() => { publishAwsAttention("disk", low); }, [low]);
  const categories = report ? [...report.categories].filter((item) => item.bytes > 0)
    .sort((a, b) => a.id === "swap" ? 1 : b.id === "swap" ? -1 : b.bytes - a.bytes) : [];
  const shown = categories.reduce((sum, item) => sum + item.bytes, 0);

  return (
    <section className="gen-section" data-testid="aws-disk">
      <div className="gen-section-head">
        <h2 className="gen-section-title">Disk</h2>
        {running && report ? (
          <span className="gen-section-meta">
            {disk.measuring ? <AwsWaiting>Measuring…</AwsWaiting> : `${formatBytes(report.usedBytes)} of ${formatBytes(report.totalBytes)} used · ${formatBytes(report.availableBytes)} free`}
          </span>
        ) : null}
      </div>
      <div className="gen-card">
        {!running ? (
          <Row title="Usage" desc="Shown while the instance runs." />
        ) : !report ? (
          <Row title="Usage" desc={disk.error ? undefined : <AwsWaiting>Measuring the disk… On a small instance this takes about a minute.</AwsWaiting>} error={disk.error} />
        ) : (
          <>
            <div className="gen-row gen-row-stack">
              <div className="gen-aws-disk-bar" role="img" aria-label={`${formatBytes(report.usedBytes)} of ${formatBytes(report.totalBytes)} used`}>
                {categories.map((item) => (
                  <span key={item.id} className={CATEGORY[item.id].tone} style={{ flex: `${item.bytes} 1 0px` }} />
                ))}
                <span className="gen-aws-disk-free" style={{ flex: `${Math.max(0, report.totalBytes - shown)} 1 0px` }} />
              </div>
              {report.availableBytes < AWS_DISK_LOW_BYTES ? (
                <div className="gen-row-error" data-testid="aws-disk-low">
                  Only {formatBytes(report.availableBytes)} free. Below about 2 GB, updates and agents start to fail.
                </div>
              ) : null}
              {disk.error ? <div className="gen-row-error">{disk.error}</div> : null}
            </div>
            {categories.map((item) => {
              const text = CATEGORY[item.id];
              const action = text.clean && item.cleanableBytes ? { label: "Clean up", onClick: () => setCleaning(item), testId: `aws-disk-clean-${item.id}` }
                : text.browse ? { label: "Browse…", onClick: () => setBrowse(text.browse), testId: `aws-disk-browse-${item.id}` } : undefined;
              return (
                <Fragment key={item.id}>
                  <div className="gen-card-divider" />
                  <Row testId={`aws-disk-${item.id}`} title={<><span className={`gen-aws-swatch ${text.tone}`} aria-hidden />{text.label} · {formatBytes(item.bytes)}</>}
                    desc={text.describe(item)} action={action} />
                </Fragment>
              );
            })}
            <div className="gen-card-divider" />
            <Row title="All files" desc="Everything in your home folder on the instance, largest first."
              action={{ label: "Browse…", onClick: () => setBrowse(""), testId: "aws-disk-browse-all" }} />
          </>
        )}
        <div className="gen-card-divider" />
        {sizeRow}
      </div>
      <AwsDiskBrowser open={browse !== undefined} start={browse ?? ""} disk={disk} onClose={() => setBrowse(undefined)} />
      <AwsCleanDialog category={cleaning} disk={disk} onClose={() => setCleaning(undefined)} />
      <AwsGrowDialog open={growing} control={c} disk={disk} onClose={() => setGrowing(false)} />
    </section>
  );
}

function AwsCleanDialog(props: { category?: AwsDiskCategory; disk: AwsDiskControl; onClose: () => void }): JSX.Element {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const category = props.category;
  const text = category ? CATEGORY[category.id] : undefined;
  useEffect(() => { setError(undefined); }, [category?.id]);
  const confirm = async (): Promise<void> => {
    if (!text?.clean) return;
    setPending(true);
    setError(undefined);
    try {
      const result = await props.disk.clean(text.clean);
      const kept = keptText(result.failed);
      if (kept) setError(kept);
      else props.onClose();
    } catch (cause) {
      setError(cleanError(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <AwsDialog
      open={Boolean(category)}
      title={text ? `Clean up ${text.label.toLowerCase()}?` : ""}
      testId="aws-disk-clean-dialog"
      busy={pending}
      onClose={props.onClose}
      description={category && text?.cleans ? `${text.cleans(category)} The instance has no trash, so this cannot be undone.` : ""}
      actions={<>
        <Button type="button" variant="outline" size="sm" disabled={pending} onClick={props.onClose}>Cancel</Button>
        <Button type="button" size="sm" data-testid="aws-disk-clean-confirm" disabled={pending} onClick={() => void confirm()}>
          {pending ? <Loader2 size={14} className="gen-aws-spinner" aria-hidden /> : null}
          {pending ? "Cleaning up…" : `Clean up ${formatBytes(category?.cleanableBytes ?? 0)}`}
        </Button>
      </>}
    >
      {error ? <div className="gen-row-error" role="alert">{error}</div> : null}
    </AwsDialog>
  );
}

function AwsGrowDialog(props: { open: boolean; control: AwsWorkerControl; disk: AwsDiskControl; onClose: () => void }): JSX.Element {
  const c = props.control;
  const current = c.actual?.rootVolumeSizeGb ?? 0;
  const [value, setValue] = useState("");
  useEffect(() => { if (props.open) setValue(String(Math.min(AWS_WORKER_ROOT_VOLUME_SIZE_GB_MAX, Math.max(current + 1, Math.ceil(current * 1.5))))); }, [props.open, current]);
  const size = Number(value);
  const valid = Number.isInteger(size) && size > current && size <= AWS_WORKER_ROOT_VOLUME_SIZE_GB_MAX;
  const stopped = c.status?.state !== "running";
  return (
    <AwsDialog
      open={props.open}
      title="Grow the disk"
      testId="aws-grow-dialog"
      onClose={props.onClose}
      description={`The disk grows in place and everything on it stays. AWS cannot make it smaller again, and a larger disk costs more.${stopped ? " The instance starts to finish growing it." : ""}`}
      actions={<>
        <Button type="button" variant="outline" size="sm" onClick={props.onClose}>Cancel</Button>
        <Button type="button" size="sm" data-testid="aws-grow-apply" disabled={!valid || c.locked}
          onClick={() => { props.onClose(); void c.growDisk(size).then((grown) => { if (grown) void props.disk.measure(true); }); }}>
          {valid ? `Grow to ${size} GiB` : "Grow"}
        </Button>
      </>}
    >
      <label className="gen-aws-field">
        <span>New size, GiB</span>
        <input className="gen-input gen-aws-narrow" type="number" inputMode="numeric" min={current + 1} max={AWS_WORKER_ROOT_VOLUME_SIZE_GB_MAX}
          aria-label="New disk size in GiB" value={value} onChange={(event) => setValue(event.target.value)} />
        <span className={valid || !value ? "gen-aws-hint" : "gen-row-error"}>
          {valid || !value ? `Now ${current} GiB. Whole GiB, up to ${AWS_WORKER_ROOT_VOLUME_SIZE_GB_MAX}.`
            : size <= current ? `AWS cannot make the disk smaller; choose more than ${current} GiB.` : `Choose a whole number up to ${AWS_WORKER_ROOT_VOLUME_SIZE_GB_MAX}.`}
        </span>
      </label>
    </AwsDialog>
  );
}
