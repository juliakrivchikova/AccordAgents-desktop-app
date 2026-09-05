import { useEffect, useState } from "react";
import { Copy, Loader2, Plus, Server, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CreateMachineResult, MachineLinkStatus, MachineListResult, MachineRecord } from "../../../shared/machineLink";
import { writeClipboardText } from "../../../shared/clipboard";

/**
 * Machines transport: computers that run the app without a window and host
 * participants. Adding one mints an enrollment file; installing that file on
 * the computer connects it through the relay.
 */
export function MachinesSection(): JSX.Element {
  const [machines, setMachines] = useState<MachineRecord[]>([]);
  const [status, setStatus] = useState<MachineLinkStatus[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [enrollment, setEnrollment] = useState<CreateMachineResult | undefined>();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const apply = (result: MachineListResult): void => {
      if (cancelled) {
        return;
      }
      setMachines(result.machines);
      setStatus(result.status);
    };
    void window.consensus.listMachines().then(apply).catch((listError) => {
      if (!cancelled) {
        setError(listError instanceof Error ? listError.message : String(listError));
      }
    });
    const off = window.consensus.onMachinesUpdated(apply);
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  async function addMachine(): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed || busy) {
      return;
    }
    setBusy(true);
    setError(undefined);
    setCopied(false);
    try {
      const result = await window.consensus.createMachine({ name: trimmed });
      setEnrollment(result);
      setName("");
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setBusy(false);
    }
  }

  async function showEnrollment(machine: MachineRecord): Promise<void> {
    setError(undefined);
    setCopied(false);
    try {
      setEnrollment(await window.consensus.machineEnrollment({ id: machine.id }));
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : String(readError));
    }
  }

  async function removeMachine(machine: MachineRecord): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const result = await window.consensus.removeMachine({ id: machine.id });
      setMachines(result.machines);
      setStatus(result.status);
      if (enrollment?.machine.id === machine.id) {
        setEnrollment(undefined);
      }
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : String(removeError));
    } finally {
      setBusy(false);
    }
  }

  async function copyEnrollment(): Promise<void> {
    if (!enrollment) {
      return;
    }
    const result = await writeClipboardText(enrollment.enrollmentJson, (value) => navigator.clipboard.writeText(value));
    setCopied(result === "copied");
    if (result !== "copied") {
      setError("Copy failed.");
    }
  }

  const statusById = new Map(status.map((item) => [item.machineId, item]));

  return (
    <section className="gen-section" data-testid="machines-section">
      <h2 className="gen-section-title gen-section-title-solo">Machines</h2>
      <div className="gen-card">
        <div className="gen-row">
          <div className="gen-row-text">
            <div className="gen-row-title">Computers that host members</div>
            <div className="gen-row-desc">
              A machine runs AccordAgents without a window and hosts the members you assign to it. Install the enrollment file on the
              computer, start the machine runtime, and it connects through the relay like your phone does.
            </div>
          </div>
          <div className="gen-row-control machines-add">
            <Label htmlFor="machine-name" className="sr-only">Machine name</Label>
            <Input
              id="machine-name"
              value={name}
              placeholder="Machine name"
              data-testid="machine-name-input"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void addMachine();
                }
              }}
            />
            <button
              type="button"
              className="gen-pill"
              data-testid="machine-add"
              disabled={busy || !name.trim()}
              onClick={() => void addMachine()}
            >
              <span className="gen-pill-lead">{busy ? <Loader2 className="spin" size={16} aria-hidden /> : <Plus size={16} aria-hidden />}</span>
              <span className="gen-pill-label">Add machine</span>
            </button>
          </div>
        </div>
        {machines.length > 0 ? (
          <>
            <div className="gen-card-divider" />
            <ul className="machines-list" data-testid="machines-list">
              {machines.map((machine) => {
                const live = statusById.get(machine.id);
                const connected = live?.connected === true;
                return (
                  <li key={machine.id} className="gen-row machines-row" data-testid="machine-row" data-connected={connected ? "true" : "false"}>
                    <div className="gen-row-text">
                      <div className="gen-row-title machines-row-title">
                        <Server size={14} aria-hidden />
                        <span>{machine.name}</span>
                        <span className={`machines-state${connected ? " is-connected" : ""}`}>{connected ? "Connected" : "Not connected"}</span>
                      </div>
                      <div className="gen-row-desc">
                        {live?.lastHello
                          ? `${live.lastHello.machineName} · ${live.lastHello.platform} · app ${live.lastHello.appVersion}`
                          : "Waiting for the machine runtime to connect."}
                        {machine.lastSeenAt ? ` Last seen ${new Date(machine.lastSeenAt).toLocaleString()}.` : ""}
                      </div>
                    </div>
                    <div className="gen-row-control machines-row-actions">
                      <button type="button" className="gen-pill" onClick={() => void showEnrollment(machine)} data-testid="machine-show-enrollment">
                        <span className="gen-pill-label">Enrollment</span>
                      </button>
                      <button type="button" className="gen-pill machines-remove" onClick={() => void removeMachine(machine)} data-testid="machine-remove" disabled={busy}>
                        <span className="gen-pill-lead"><Trash2 size={14} aria-hidden /></span>
                        <span className="gen-pill-label">Remove</span>
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}
        {enrollment ? (
          <>
            <div className="gen-card-divider" />
            <div className="gen-row machines-enrollment" data-testid="machine-enrollment">
              <div className="gen-row-text">
                <div className="gen-row-title">Enrollment for {enrollment.machine.name}</div>
                <div className="gen-row-desc">
                  Save this as <code>enrollment.json</code> on the machine and start the runtime with
                  {" "}<code>accordagents-machine --enrollment enrollment.json</code>. The file carries the relay key: treat it like a password.
                </div>
                <textarea
                  className="machines-enrollment-json"
                  readOnly
                  value={enrollment.enrollmentJson}
                  rows={6}
                  data-testid="machine-enrollment-json"
                />
              </div>
              <div className="gen-row-control">
                <button type="button" className="gen-pill" onClick={() => void copyEnrollment()} data-testid="machine-copy-enrollment">
                  <span className="gen-pill-lead"><Copy size={14} aria-hidden /></span>
                  <span className="gen-pill-label">{copied ? "Copied" : "Copy"}</span>
                </button>
              </div>
            </div>
          </>
        ) : null}
        {error ? <div className="device-pairing-error" data-testid="machines-error">{error}</div> : null}
      </div>
    </section>
  );
}
