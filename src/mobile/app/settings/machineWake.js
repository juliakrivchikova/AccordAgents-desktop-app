import { render } from "../chat/render.js";
import { hubClient, isHubPairing } from "../pairing/hubPairing.js";
import { loadPairing } from "../pairing/pairing.js";
import { settingsViewState } from "./settingsView.js";
import { hubPhoneGet } from "../sync/serverReads.js";

// --- waking a machine ------------------------------------------------------
// The phone holds no key for any machine: it asks the User's server, which
// starts one itself when work waits for it, and now when asked.

// The machines the server knows, and what it says about waking each.
export let hubMachines = [];

export const hubMachineWake = new Map();

export async function refreshHubMachines() {
  if (!isHubPairing(loadPairing())) return;
  const answer = await hubPhoneGet("/v1/phone/machines", {}).catch(function () { return undefined; });
  if (answer && Array.isArray(answer.machines) && JSON.stringify(answer.machines) !== JSON.stringify(hubMachines)) {
    hubMachines = answer.machines;
    settingsViewState.lastSettingsRenderSignature = "";
    await render();
  }
}

/** Asks the server to start a stopped machine now. */
export async function wakeHubMachine(machineId) {
  hubMachineWake.set(machineId, { status: "waking", detail: "Asking your server to start the machine…" });
  settingsViewState.lastSettingsRenderSignature = "";
  await render();
  try {
    const client = hubClient();
    if (!client) throw new Error("This phone is not paired with a server.");
    const answer = await client.postJson("/v1/phone/wake", { machineId: machineId });
    hubMachineWake.set(machineId, { status: answer && answer.started ? "started" : "error",
      detail: answer && answer.message ? String(answer.message) : "Start requested." });
  } catch (error) {
    hubMachineWake.set(machineId, { status: "error", detail: "Could not reach your server: " + String(error && error.message || error) });
  }
  settingsViewState.lastSettingsRenderSignature = "";
  await render();
  void refreshHubMachines();
}
