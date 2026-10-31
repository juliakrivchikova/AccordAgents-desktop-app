import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Folder, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AwsInstanceProject, AwsInstanceProjects } from "../../../shared/types";
import { AwsConfirmDialog, AwsDialog, AwsWaiting } from "./aws-dialog";
import { Row } from "./aws-row";
import { cleanError } from "./aws-shared";
import { formatBytes, keptText, LOCK_TEXT, plural, WORK_TEXT, type AwsDiskControl } from "./use-aws-disk";

/** A path on this computer the way the User reads it. */
function shortPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

function workText(copy: AwsInstanceProject): string | undefined {
  return copy.work?.length ? copy.work.map((kind) => WORK_TEXT[kind]).join(" · ") : undefined;
}

/**
 * Settings → AWS → Projects: the one place where the projects on the
 * instance are seen, added and deleted. Deleting asks the instance, which
 * keeps whatever is in use; adding makes the same copy a cloud member's
 * first turn in a project makes.
 */
export function AwsProjectsSection(props: { running: boolean; locked?: boolean; disk: AwsDiskControl }): JSX.Element {
  const [projects, setProjects] = useState<AwsInstanceProjects>();
  const [error, setError] = useState<string>();
  const [deleting, setDeleting] = useState<AwsInstanceProject>();
  const [adding, setAdding] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const load = useCallback(async (): Promise<void> => {
    setError(undefined);
    try {
      const next = await window.consensus.listAwsInstanceProjects();
      if (mounted.current) setProjects(next);
    } catch (cause) {
      if (mounted.current) setError(cleanError(cause));
    }
  }, []);
  useEffect(() => { if (props.running) void load(); }, [props.running, load]);

  const copies = projects?.copies ?? [];
  const available = projects?.available ?? [];
  return (
    <section className="gen-section" data-testid="aws-projects">
      <div className="gen-section-head">
        <h2 className="gen-section-title">Projects on the instance</h2>
        {props.running && projects ? <span className="gen-section-meta">{copies.length} of {plural(copies.length + available.length, "project")}</span> : null}
      </div>
      <div className="gen-card">
        {!props.running ? (
          <Row title="Projects" desc="Shown while the instance runs." />
        ) : !projects ? (
          <Row title="Projects" desc={error ? undefined : <AwsWaiting>Reading the projects on the instance…</AwsWaiting>} error={error} />
        ) : (
          <>
            {copies.map((copy) => {
              const lock = copy.lock ? LOCK_TEXT[copy.lock] ?? "protected" : undefined;
              const work = workText(copy);
              return (
                <Fragment key={copy.path}>
                  <Row testId="aws-project" title={`${copy.name} · ${formatBytes(copy.bytes)}`}
                    desc={<>
                      {copy.localPath ? shortPath(copy.localPath) : "Not linked to a project on this computer"}
                      {work ? ` · holds members' work: ${work}` : ""}
                      {lock ? ` · ${lock}` : ""}
                    </>}
                    action={{ label: "Delete…", ariaLabel: `Delete ${copy.name} from the instance`, onClick: () => setDeleting(copy),
                      disabled: Boolean(copy.lock) || props.locked, testId: "aws-project-delete" }} />
                  <div className="gen-card-divider" />
                </Fragment>
              );
            })}
            <Row title="Add a project" testId="aws-project-add-row"
              desc={projects.addUnavailable ?? (available.length
                ? "Copies a project from this computer to the instance, so cloud members can work in it. The copy is theirs from then on and is never overwritten."
                : "Every project on this computer is on the instance.")}
              error={error}
              action={{ label: "Add project…", onClick: () => setAdding(true), disabled: Boolean(projects.addUnavailable) || !available.length || props.locked, testId: "aws-project-add" }} />
          </>
        )}
      </div>
      <AwsProjectDeleteDialog copy={deleting} disk={props.disk} onClose={() => setDeleting(undefined)} onDeleted={() => { setDeleting(undefined); void load(); }} />
      <AwsProjectAddDialog open={adding} projects={projects} onClose={() => setAdding(false)}
        onAdded={() => { setAdding(false); void load(); void props.disk.measure(true); }}
        onCancelled={() => { setAdding(false); void load(); }} />
    </section>
  );
}

function AwsProjectDeleteDialog(props: { copy?: AwsInstanceProject; disk: AwsDiskControl; onClose: () => void; onDeleted: () => void }): JSX.Element {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const copy = props.copy;
  useEffect(() => { setError(undefined); }, [copy?.path]);
  const work = copy ? workText(copy) : undefined;
  const confirm = async (): Promise<void> => {
    if (!copy) return;
    setPending(true);
    setError(undefined);
    try {
      const result = await props.disk.remove([copy.path], copy.work?.length ? { [copy.path]: copy.work } : {});
      const kept = keptText(result.failed);
      if (kept) setError(kept);
      else props.onDeleted();
    } catch (cause) {
      setError(cleanError(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <AwsConfirmDialog
      open={Boolean(copy)}
      title={copy ? `Delete ${copy.name}?` : "Delete project"}
      testId="aws-project-delete-dialog"
      description={copy ? <>
        Deletes the copy of {copy.name} from the instance and frees {formatBytes(copy.bytes)}.
        {work ? ` It holds members' work that is only there (${work}), which is deleted with it.` : ""}
        {copy.localPath ? " The project on this computer stays, and the next message to a cloud member in it copies it again." : ""}
      </> : ""}
      confirmLabel="Delete"
      pending={pending}
      error={error}
      onConfirm={() => void confirm()}
      onClose={props.onClose}
    />
  );
}

function AwsProjectAddDialog(props: { open: boolean; projects?: AwsInstanceProjects; onClose: () => void; onAdded: () => void; onCancelled: () => void }): JSX.Element {
  const available = props.projects?.available ?? [];
  const [chosen, setChosen] = useState<string>();
  const [copying, setCopying] = useState<{ localPath: string; message?: string }>();
  const [error, setError] = useState<string>();
  // Cancel during a copy ends it and closes, as Cancel does elsewhere.
  const cancelled = useRef(false);
  useEffect(() => {
    if (!props.open) return;
    setError(undefined);
    setChosen((current) => current && available.some((project) => project.path === current) ? current : available[0]?.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, props.projects]);
  useEffect(() => {
    if (!props.open) return undefined;
    return window.consensus.onAwsInstanceProjectProgress((progress) => {
      setCopying((current) => current?.localPath === progress.localPath ? { ...current, message: progress.message } : current);
    });
  }, [props.open]);
  const label = available.find((project) => project.path === chosen)?.label;
  const add = async (): Promise<void> => {
    if (!chosen) return;
    cancelled.current = false;
    setCopying({ localPath: chosen });
    setError(undefined);
    try {
      await window.consensus.addAwsInstanceProject(chosen);
      setCopying(undefined);
      props.onAdded();
    } catch (cause) {
      setCopying(undefined);
      // What a cancelled copy left (nothing, or a copy that was already
      // there) shows in the list.
      if (cancelled.current) props.onCancelled();
      else setError(cleanError(cause));
    }
  };
  const cancel = (): void => {
    if (!copying) { props.onClose(); return; }
    cancelled.current = true;
    void window.consensus.cancelAwsInstanceProjectAdd(copying.localPath);
  };
  const free = props.projects?.freeBytes;
  return (
    <AwsDialog
      open={props.open}
      wide
      title="Add a project"
      testId="aws-project-add-dialog"
      busy={Boolean(copying)}
      onClose={props.onClose}
      description="Your projects that are not on the instance yet. The project is copied as it is on this computer now. Cloud members then work in that copy and hand changes back as pull requests."
      note={copying ? `${copying.message ?? "Starting the copy…"}` : free !== undefined ? `${formatBytes(free)} free on the instance` : undefined}
      actions={<>
        <Button type="button" variant="outline" size="sm" data-testid="aws-project-add-cancel" onClick={cancel}>Cancel</Button>
        <Button type="button" size="sm" data-testid="aws-project-add-confirm" disabled={Boolean(copying) || !chosen} onClick={() => void add()}>
          {copying ? <Loader2 size={14} className="gen-aws-spinner" aria-hidden /> : null}
          {copying ? "Copying…" : label ? `Copy ${label}` : "Copy"}
        </Button>
      </>}
    >
      <div className="gen-aws-tree" data-testid="aws-project-add-list" role="radiogroup" aria-label="Your projects not on the instance">
        {available.map((project) => (
          <label key={project.path} className="gen-aws-tree-row is-choice" style={{ paddingLeft: 12 }} data-path={project.path}>
            <span className="gen-aws-tree-check">
              <input type="radio" name="aws-project-add" checked={project.path === chosen} disabled={Boolean(copying)}
                onChange={() => setChosen(project.path)} aria-label={`${project.label}, ${shortPath(project.path)}`} />
            </span>
            <Folder size={15} className="gen-aws-tree-icon" aria-hidden />
            <span className="gen-aws-tree-name" title={project.path}><code>{project.label}</code><span> · {shortPath(project.path)}</span></span>
          </label>
        ))}
      </div>
      {error ? <div className="gen-row-error" role="alert" data-testid="aws-project-add-error">{error}</div> : null}
    </AwsDialog>
  );
}
