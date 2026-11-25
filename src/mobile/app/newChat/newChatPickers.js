import { lineIcon } from "../activity/activityData.js";
import { mobileSharedRules } from "../members/avatars.js";
import { memberKindLabel, memberLocationLabel } from "../members/membersSheet.js";
import {
  isMainSessionMember, newChatAvatar, newChatCheck, newChatMachineFitsProject, newChatMachineList, newChatMainSelection,
  newChatProjectPlace, newChatProviders, newChatSessionsView, pruneNewChatChosen
} from "./newChatChoices.js";
import { closeNewChatPickers, NEW_CHAT_FOLDER_ICON, NEW_CHAT_NO_PROJECT_ICON, newChatOffer, newChatOfferState } from "./newChatOffer.js";
import { renderNewChat } from "./newChatScreen.js";
import { providerLogoElement } from "../sessions/sessionsStatus.js";

function newChatOptionRow(options) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "members-sheet-row new-chat-option new-chat-model-option";
  row.setAttribute("aria-pressed", options.chosen ? "true" : "false");
  if (options.data) for (const key of Object.keys(options.data)) row.dataset[key] = options.data[key];
  const copy = document.createElement("span");
  copy.className = "members-sheet-copy";
  const name = document.createElement("strong");
  name.textContent = options.label;
  copy.append(name);
  if (options.detail) {
    const detail = document.createElement("span");
    detail.className = "members-sheet-location";
    detail.textContent = options.detail;
    copy.append(detail);
  }
  if (options.mark) row.append(options.mark);
  row.append(copy, newChatCheck(options.chosen));
  row.addEventListener("click", options.onClick);
  return row;
}

/** The chip's sheet: the providers, the chosen one's models (its default
 *  first) and its efforts. */
export function renderNewChatModelOptions(offer) {
  const list = document.getElementById("new-chat-model-options");
  if (!list) return;
  list.replaceChildren();
  const selection = offer && newChatSessionsView(offer) ? newChatMainSelection(offer) : undefined;
  if (!selection) return;
  const section = function (text) {
    const head = document.createElement("div");
    head.className = "members-sheet-section";
    head.textContent = text;
    list.append(head);
  };
  // Only what she chose here is hers; the rest follows the computer's
  // Settings → General → New chats (newChatMainSelection). Another provider
  // starts from its own, as the computer drops what was chosen for the one
  // before.
  const choose = function (patch) {
    const sameProvider = function (item) {
      return Boolean(item) && item.kind === selection.provider.kind && (item.hostId || "") === (selection.provider.hostId || "");
    };
    const current = { kind: selection.provider.kind, hostId: selection.provider.hostId };
    if (sameProvider(newChatOfferState.newChatMainChoice) && (patch.kind === undefined || sameProvider(patch))) {
      for (const key of ["model", "reasoningEffort", "access", "plan", "homeMachineId"]) {
        if (Object.prototype.hasOwnProperty.call(newChatOfferState.newChatMainChoice, key)) current[key] = newChatOfferState.newChatMainChoice[key];
      }
    }
    newChatOfferState.newChatMainChoice = Object.assign(current, patch);
    renderNewChat("");
  };
  section("Provider");
  for (const provider of newChatProviders(offer)) {
    const chosen = provider.kind === selection.provider.kind && (provider.hostId || "") === (selection.provider.hostId || "");
    list.append(newChatOptionRow({ label: provider.label, chosen: chosen, mark: providerLogoElement(provider.kind, "is-small"),
      data: { providerKind: provider.kind, hostId: provider.hostId || "" },
      // Another provider: its own default model, effort and mode, as the
      // computer drops what was chosen for the one before.
      onClick: function () {
        if (chosen) return;
        choose({ kind: provider.kind, hostId: provider.hostId });
      } }));
  }
  section("Model");
  list.append(newChatOptionRow({ label: selection.provider.defaultModelLabel, detail: "Default", chosen: !selection.model, data: { model: "" },
    onClick: function () { choose({ model: undefined }); } }));
  for (const model of selection.provider.models) {
    list.append(newChatOptionRow({ label: model.label, chosen: selection.model === model.id, data: { model: model.id },
      onClick: function () { choose({ model: model.id }); } }));
  }
  section("Effort");
  list.append(newChatOptionRow({ label: "Default", detail: selection.startEffortLabel, chosen: !selection.effort, data: { effort: "" },
    onClick: function () { choose({ reasoningEffort: undefined }); } }));
  for (const effort of selection.efforts) {
    list.append(newChatOptionRow({ label: effort.label, chosen: selection.effort === effort.id, data: { effort: effort.id },
      onClick: function () { choose({ reasoningEffort: effort.id }); } }));
  }
  if (selection.accessOptions.length > 0) {
    // Under the CLI's own title ("Permission mode", "Permissions", "Agent Mode").
    section(selection.accessSet && selection.accessSet.title ? selection.accessSet.title : "Access");
    for (const option of selection.accessOptions) {
      list.append(newChatOptionRow({ label: option.label, detail: option.detail, chosen: selection.access === option.id, data: { access: option.id },
        onClick: function () {
          // Codex asks before it switches to Full Access, in its own words.
          if (option.agentMode === "full-access" && selection.access !== option.id) {
            renderNewChatFullAccessConfirm(list, function () { choose({ access: option.id }); }, function () { renderNewChatModelOptions(offer); });
            return;
          }
          choose({ access: option.id });
        } }));
    }
    if (selection.accessSet && selection.accessSet.note) {
      const note = document.createElement("p");
      note.className = "members-sheet-note new-chat-access-note";
      note.textContent = selection.accessSet.note;
      list.append(note);
    }
    // Codex's Plan mode, a choice of its own beside the permissions.
    if (selection.planOffered) {
      section(selection.accessSet.plan.label);
      list.append(newChatOptionRow({ label: "Off", chosen: !selection.plan, data: { plan: "off" }, onClick: function () { choose({ plan: false }); } }));
      list.append(newChatOptionRow({ label: "On", chosen: selection.plan, data: { plan: "on" }, onClick: function () { choose({ plan: true }); } }));
    }
  }
  const machines = newChatMachineList();
  if (machines.length > 0) {
    section("Runs on");
    list.append(newChatOptionRow({ label: "This computer", chosen: !selection.homeMachineId, data: { runsOn: "" },
      onClick: function () { choose({ homeMachineId: undefined }); } }));
    for (const machine of machines) {
      list.append(newChatOptionRow({ label: machine.name, chosen: selection.homeMachineId === machine.id, data: { runsOn: machine.id },
        detail: newChatMachineFitsProject(machine.id) ? undefined : "Does not have this project",
        onClick: function () { choose({ homeMachineId: machine.id }); } }));
    }
  }
}

/** Codex's own question before Full Access (Codex 0.155.1's `/permissions`,
 *  shared with the computer: FULL_ACCESS_CONFIRMATION), in place of the
 *  choices until it is answered. */
function renderNewChatFullAccessConfirm(list, confirm, back) {
  const shared = mobileSharedRules();
  const words = shared && shared.FULL_ACCESS_CONFIRMATION;
  if (!words) {
    confirm();
    return;
  }
  list.replaceChildren();
  // Laid out as the phone's other question before a step that matters (a
  // pairing code's): the question, then the step as the filled button and
  // going back as the outlined one, each with Codex's line under it.
  const box = document.createElement("div");
  box.className = "new-chat-confirm";
  const title = document.createElement("div");
  title.className = "new-chat-confirm-title";
  title.textContent = words.title;
  const body = document.createElement("p");
  body.className = "new-chat-confirm-body";
  body.textContent = words.body;
  const actions = document.createElement("div");
  actions.className = "pairing-form new-chat-confirm-actions";
  const action = function (className, choice, which, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className + " new-chat-confirm-action";
    button.dataset.confirm = which;
    const label = document.createElement("span");
    label.textContent = choice.label;
    const detail = document.createElement("span");
    detail.className = "new-chat-confirm-detail";
    detail.textContent = choice.detail;
    button.append(label, detail);
    button.addEventListener("click", onClick);
    return button;
  };
  actions.append(action("pairing-submit", words.confirm, "yes", confirm), action("pairing-cancel", words.cancel, "cancel", back));
  box.append(title, body, actions);
  list.append(box);
}

/** A member's name on New chat. The main session is named by its provider
 *  (an added provider by its own name, else its CLI's, spelled as the
 *  computer's chatCliProviderLabel spells it), as the computer's sessions
 *  view names it; no words name a main session (the User, 2026-11-22).
 *  The computer's classic New chat names it by its @ name, which this row
 *  shows on its second line. */
export function newChatMemberName(participant) {
  if (isMainSessionMember(participant)) return newChatProviderName(participant);
  return participant.roleConfigId === "administrator" ? "Chat Assistant" : "@" + participant.handle;
}

function newChatProviderName(participant) {
  const host = typeof participant.hostLabel === "string" ? participant.hostLabel.trim() : "";
  if (host) return host;
  return participant.kind === "gemini-cli" ? "Antigravity" : memberKindLabel(participant.kind) || "CLI";
}

/** A member row's second line on New chat: its role and its CLI. The main
 *  session's name is already its provider, so its @ name stands there
 *  alone. */
export function newChatMemberRoleLine(participant) {
  if (isMainSessionMember(participant)) return "@" + participant.handle;
  const role = newChatOffer && newChatOffer.roles[participant.roleConfigId];
  return [role, memberKindLabel(participant.kind)].filter(Boolean).join(" \u00b7 ");
}

export function newChatProjectRow(project, chosen) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "members-sheet-row new-chat-option";
  row.dataset.path = project ? project.path : "";
  row.setAttribute("aria-pressed", chosen ? "true" : "false");
  const icon = document.createElement("span");
  icon.className = "new-chat-project-icon";
  icon.append(lineIcon(project ? NEW_CHAT_FOLDER_ICON : NEW_CHAT_NO_PROJECT_ICON, 18));
  const copy = document.createElement("span");
  copy.className = "members-sheet-copy";
  const name = document.createElement("strong");
  name.textContent = project ? project.label : "No project";
  const where = document.createElement("span");
  where.className = "members-sheet-location";
  where.textContent = project ? newChatProjectPlace(project.path) : "The chat works without project files";
  copy.append(name, where);
  row.append(icon, copy, newChatCheck(chosen));
  row.addEventListener("click", function () {
    newChatOfferState.newChatProject = project ? project.path : "";
    pruneNewChatChosen();
    closeNewChatPickers();
    renderNewChat();
  });
  return row;
}

export function newChatMemberRow(participant, options) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "members-sheet-row new-chat-option new-chat-member";
  row.dataset.handle = participant.handle;
  row.setAttribute("aria-pressed", options.chosen ? "true" : "false");
  if (options.locked || options.unavailable) row.setAttribute("aria-disabled", "true");
  if (options.unavailable) row.dataset.unavailable = "1";
  const copy = document.createElement("span");
  copy.className = "members-sheet-copy";
  const name = document.createElement("strong");
  name.textContent = newChatMemberName(participant);
  const role = document.createElement("span");
  role.className = "members-sheet-role";
  role.textContent = newChatMemberRoleLine(participant);
  const where = document.createElement("span");
  where.className = "members-sheet-location";
  const machineId = options.machineId || participant.homeMachineId;
  where.textContent = options.unavailable || memberLocationLabel({ homeMachineId: machineId, cloudRun: participant.cloudRun,
    homeMachineName: machineId && newChatOffer ? newChatOffer.machines[machineId] : undefined });
  copy.append(name, role, where);
  row.append(newChatAvatar(participant), copy, newChatCheck(options.chosen));
  return row;
}
