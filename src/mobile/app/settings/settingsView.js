import { render } from "../chat/render.js";
import { openSendLog, owedSummary, sendLogCount, sendLogNewestAt, sendLogTime } from "../outbox/sendLog.js";
import { isHubPairing } from "../pairing/hubPairing.js";
import { loadPairing } from "../pairing/pairing.js";
import { enableMessageAlerts, messageAlertsState, pushEndpointRejected, reconnectMessageAlerts } from "../push/messageAlerts.js";
import { hubMachines, hubMachineWake, wakeHubMachine } from "./machineWake.js";
import { relativeTime } from "../sync/connectionStatus.js";

export const settingsViewState = {
  lastSettingsRenderSignature: ""
};

function settingsGroup(title, rows) {
  const section = document.createElement("section");
  const heading = document.createElement("div");
  heading.className = "set-group-title";
  heading.textContent = title;
  const group = document.createElement("div");
  group.className = "set-group";
  for (const row of rows) group.append(row);
  section.append(heading, group);
  return section;
}

function settingsRow(title, sub, control) {
  const row = document.createElement("div");
  row.className = "set-row";
  const copy = document.createElement("div");
  copy.className = "set-copy";
  const strong = document.createElement("span");
  strong.className = "set-title";
  strong.textContent = title;
  copy.append(strong);
  if (sub) {
    const small = document.createElement("span");
    small.className = "set-sub";
    small.textContent = sub;
    copy.append(small);
  }
  row.append(copy);
  if (control) row.append(control);
  return row;
}

function settingsButton(label, onClick, disabled) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "set-button";
  button.textContent = label;
  button.disabled = Boolean(disabled);
  button.addEventListener("click", onClick);
  return button;
}

/** What this phone can change about itself. Only what it can actually do:
 *  iOS does not let a web app turn its own alerts off, so they are offered
 *  while undecided and otherwise described, not drawn as a switch. */
export function renderSettings() {
  const list = document.getElementById("settings-list");
  if (!list) return;
  const permission = "Notification" in globalThis ? Notification.permission : "unsupported";
  const hubPaired = isHubPairing(loadPairing());
  const pushable = hubPaired && "Notification" in globalThis && "PushManager" in globalThis;
  const sending = owedSummary();
  const signature = JSON.stringify([permission, pushable, pushEndpointRejected, messageAlertsState.alertsReconnect, hubPaired, hubMachines,
    sending.owed, sending.failing, sendLogCount, sendLogNewestAt]);
  if (signature === settingsViewState.lastSettingsRenderSignature) return;
  settingsViewState.lastSettingsRenderSignature = signature;
  list.replaceChildren();

  // Every failed try to send, and why (agreement Д12).
  const sendLogSub = sending.owed > 0
    ? (sending.owed === 1 ? "1 thing you sent has" : sending.owed + " things you sent have") + " not reached your server yet; it is tried again while the app is open."
    : sendLogCount > 0 ? "Everything you sent has reached your server. Last failed try " + sendLogTime(sendLogNewestAt) + "."
      : "Nothing failed to send.";
  list.append(settingsGroup("This phone", [
    hubPaired
      ? settingsRow("Paired with your server", "Chats, replies and alerts come from your own server, with or without your computer.")
      : settingsRow("Not paired", "Scan the code from your computer (Settings → Device Pairing) to connect this phone."),
    ...(hubPaired ? [settingsRow("Send log", sendLogSub, settingsButton("View", function () { void openSendLog(); }))] : [])
  ]));

  let alertsSub;
  let alertsControl;
  if (pushEndpointRejected || !pushable || permission === "unsupported") {
    alertsSub = "Not available in this browser. Messages still arrive when you open the app.";
  } else if (permission === "granted") {
    alertsSub = messageAlertsState.alertsReconnect === "working"
      ? "Reconnecting this phone to alerts\u2026"
      : messageAlertsState.alertsReconnect === "ok"
        ? "On, and reconnected to this phone just now."
        : messageAlertsState.alertsReconnect === "failed"
          ? "On, but reconnecting did not go through. Try again in a moment."
          : "On. You hear about replies and questions while the app is closed.";
    alertsControl = settingsButton("Reconnect", function (event) {
      const button = event.currentTarget;
      button.disabled = true;
      messageAlertsState.alertsReconnect = "working";
      settingsViewState.lastSettingsRenderSignature = "";
      void render();
      void reconnectMessageAlerts().then(function (result) {
        messageAlertsState.alertsReconnect = result;
        settingsViewState.lastSettingsRenderSignature = "";
        void render();
      });
    }, messageAlertsState.alertsReconnect === "working");
  } else if (permission === "denied") {
    alertsSub = "Off. Turn them on for AccordAgents in your phone's settings.";
  } else {
    alertsSub = "When a member replies or needs you.";
    alertsControl = settingsButton("Turn on", function (event) {
      const button = event.currentTarget;
      button.disabled = true;
      void enableMessageAlerts().finally(function () {
        settingsViewState.lastSettingsRenderSignature = "";
        void render();
      });
    });
  }
  list.append(settingsGroup("Notifications", [settingsRow("Message alerts", alertsSub, alertsControl)]));

  if (hubPaired && hubMachines.length > 0) {
    // The server wakes a machine itself when work waits for it; the button
    // asks it to now. This phone holds no key of its own.
    list.append(settingsGroup("Machines", hubMachines.map(function (machine) {
      const state = hubMachineWake.get(machine.machineId);
      const waking = machine.waking || (state && state.status === "waking");
      const detail = state && state.detail ? state.detail
        : machine.waking ? "Starting… It appears once its runtime connects."
          : machine.wakeError ? machine.wakeError
            : machine.lastSeenAt ? "Last seen " + relativeTime(machine.lastSeenAt) + " ago." : "Asleep? Wake it to keep working.";
      return settingsRow(machine.name || "Cloud machine", detail, machine.canWake ? settingsButton(waking ? "Waking…" : "Wake", function () {
        void wakeHubMachine(machine.machineId);
      }, Boolean(waking)) : undefined);
    })));
  }
}
