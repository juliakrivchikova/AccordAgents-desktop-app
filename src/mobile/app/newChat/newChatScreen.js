import { createEventId, nowIso } from "../base/bytes.js";
import { render } from "../chat/render.js";
import { forgetStartedChat, loadStartedChats, noteOwnChat, saveStartedChats } from "../chats/chatStore.js";
import { openConversation, selectedConversationId } from "../chats/openChat.js";
import { addPendingAttachments } from "../composer/pickedImages.js";
import { mobileSharedRules } from "../members/avatars.js";
import { mentionOptions, normalizeMobileMember, replaceMentionAtCaret } from "../members/mentions.js";
import {
  isMainSessionMember, newChatAvatar, newChatLead, newChatMachineFitsProject, newChatMachineList, newChatMainSelection,
  newChatProjectList, newChatSessionsView, newChatVisibleMembers
} from "./newChatChoices.js";
import {
  closeNewChat, closeNewChatPickers, NEW_CHAT_REJECTED_PREFIX, newChatChosen, newChatOffer, newChatOfferState, newChatReading,
  newChatReadingAgain, openNewChat, openNewChatPicker
} from "./newChatOffer.js";
import {
  newChatMemberName, newChatMemberRoleLine, newChatMemberRow, newChatProjectRow, renderNewChatModelOptions
} from "./newChatPickers.js";
import { putOutboxEntries } from "../outbox/outboxStore.js";
import { createOutboxEvent, messageOutboxEntries, sendNow } from "../outbox/sending.js";
import { loadPairing } from "../pairing/pairing.js";
import { providerLogoElement } from "../sessions/sessionsStatus.js";
import { leaveOpenChat, switchHomeTab } from "../shell/home.js";

/** The members the chat starts with: its main session, then each one
 *  chosen, in the order the list shows them. */
function newChatChosenParticipants(offer) {
  if (!offer) return [];
  return [newChatLead(offer)].concat(newChatVisibleMembers(offer)
    .filter(function (member) { return newChatChosen.has(member.configId); })
    .map(function (member) { return member.participant; }));
}

/** Everything on the screen, the two lists included. */
export function renderNewChat(note) {
  if (note !== undefined) newChatOfferState.newChatSaid = note;
  const offer = newChatOffer && newChatOffer.options;
  const projects = document.getElementById("new-chat-projects");
  if (projects) {
    projects.replaceChildren();
    if (offer) {
      for (const project of newChatProjectList(offer)) projects.append(newChatProjectRow(project, project.path === newChatOfferState.newChatProject));
      const divider = document.createElement("div");
      divider.className = "new-chat-options-divider";
      projects.append(divider, newChatProjectRow(undefined, !newChatOfferState.newChatProject));
    }
  }
  renderNewChatModelOptions(offer);
  const list = document.getElementById("new-chat-members");
  if (list) {
    list.replaceChildren();
    if (offer && !newChatSessionsView(offer)) {
      list.append(newChatMemberRow(newChatLead(offer), { chosen: true, locked: true }));
      for (const member of newChatVisibleMembers(offer)) {
        const unavailable = member.unavailable || member.machineUnavailable;
        const row = newChatMemberRow(member.participant, { chosen: newChatChosen.has(member.configId), unavailable: unavailable, machineId: member.machineId });
        row.addEventListener("click", function () {
          if (unavailable) return;
          if (newChatChosen.has(member.configId)) newChatChosen.delete(member.configId);
          else newChatChosen.add(member.configId);
          renderNewChat("");
        });
        list.append(row);
      }
    }
  }
  renderNewChatState();
}

/** The card and the line above it, without the lists: what typing changes. */
export function renderNewChatState() {
  const offer = newChatOffer && newChatOffer.options;
  const note = newChatOfferState.newChatSaid;
  const noteNode = document.getElementById("new-chat-note");
  const start = document.getElementById("new-chat-start");
  const input = document.getElementById("new-chat-input");
  const projectButton = document.getElementById("new-chat-project");
  const projectLabel = document.getElementById("new-chat-project-label");
  const membersButton = document.getElementById("new-chat-members-button");
  const avatars = document.getElementById("new-chat-avatars");
  if (projectButton) projectButton.disabled = !offer;
  if (projectLabel) {
    const project = offer && newChatOfferState.newChatProject ? newChatProjectList(offer).find(function (item) { return item.path === newChatOfferState.newChatProject; }) : undefined;
    projectLabel.textContent = project ? project.label : "No project";
    if (projectButton) projectButton.setAttribute("aria-label", "Project: " + projectLabel.textContent);
  }
  const chosen = newChatChosenParticipants(offer);
  // The sessions view: the model chip instead of the members.
  const sessionsView = newChatSessionsView(offer);
  const modelButton = document.getElementById("new-chat-model-button");
  if (membersButton) membersButton.hidden = sessionsView;
  if (modelButton) {
    modelButton.hidden = !sessionsView;
    modelButton.disabled = !offer;
    const selection = sessionsView ? newChatMainSelection(offer) : undefined;
    const label = document.getElementById("new-chat-model-label");
    const key = selection ? [selection.provider.kind, selection.provider.hostId || "", selection.modelLabel, selection.effortLabel || ""].join("\u0000") : "";
    if (label && label.dataset.key !== key) {
      label.dataset.key = key;
      label.replaceChildren();
      if (selection) {
        const model = document.createElement("span");
        model.className = "new-chat-model-name";
        model.textContent = selection.modelLabel;
        label.append(providerLogoElement(selection.provider.kind, "is-chip"), model);
        if (selection.effortLabel) {
          const effort = document.createElement("span");
          effort.className = "new-chat-model-effort";
          effort.textContent = selection.effortLabel;
          label.append(effort);
        }
      }
    }
    modelButton.setAttribute("aria-label", selection ? "Model: " + [selection.provider.label, selection.modelLabel, selection.effortLabel].filter(Boolean).join(", ") : "Model");
  }
  if (membersButton) {
    membersButton.disabled = !offer;
    membersButton.setAttribute("aria-label", chosen.length ? "Members: " + chosen.map(newChatMemberName).join(", ") : "Members");
  }
  if (avatars) {
    const key = chosen.map(function (participant) { return participant.id; }).join(",");
    if (avatars.dataset.key !== key) {
      avatars.dataset.key = key;
      avatars.replaceChildren();
      for (const participant of chosen.slice(0, 3)) avatars.append(newChatAvatar(participant));
      if (chosen.length > 3) {
        const more = document.createElement("span");
        more.className = "new-chat-avatars-more";
        more.textContent = "+" + (chosen.length - 3);
        avatars.append(more);
      }
    }
  }
  const blocked = !offer ? note : offer.unavailable;
  // The Assistant on another CLI than the one saved in Settings: said, as
  // the computer's New chat says it, and nothing is blocked.
  const assistantNote = !note && !blocked && offer && offer.assistantNote ? offer.assistantNote : "";
  const shown = note || blocked || assistantNote;
  if (noteNode) {
    noteNode.textContent = shown || "";
    noteNode.hidden = !shown;
    if ((newChatReading && !newChatReadingAgain && !offer) || assistantNote) noteNode.dataset.tone = "info";
    else delete noteNode.dataset.tone;
  }
  const hasMessage = Boolean(input && input.value.trim()) || newChatOfferState.newChatAttachments.length > 0;
  if (start) start.disabled = newChatOfferState.newChatStarting || newChatOfferState.newChatPreparing > 0 || !offer || Boolean(offer.unavailable) || !hasMessage;
  // What is being started is what was on the card when Start was tapped.
  if (input) input.readOnly = newChatOfferState.newChatStarting;
  for (const id of ["new-chat-project", "new-chat-members-button", "new-chat-model-button"]) {
    const button = document.getElementById(id);
    const sheet = document.getElementById(id === "new-chat-project" ? "new-chat-projects-sheet" : id === "new-chat-model-button" ? "new-chat-model-sheet" : "new-chat-members-sheet");
    if (button) button.setAttribute("aria-expanded", sheet && !sheet.hidden ? "true" : "false");
  }
  if (input) {
    // The field grows with what is typed, up to its limit, and scrolls past it.
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  }
}

function renderNewChatAttachments() {
  const strip = document.getElementById("new-chat-attachments");
  if (!strip) return;
  strip.replaceChildren();
  strip.hidden = newChatOfferState.newChatAttachments.length === 0;
  for (const attachment of newChatOfferState.newChatAttachments) {
    const chip = document.createElement("div");
    chip.className = "composer-attachment-chip";
    const thumb = document.createElement("img");
    thumb.className = "composer-attachment-thumb";
    thumb.alt = attachment.filename;
    thumb.src = "data:" + attachment.mimeType + ";base64," + attachment.dataBase64;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "composer-attachment-remove";
    remove.setAttribute("aria-label", "Remove " + attachment.filename);
    remove.textContent = "×";
    remove.addEventListener("click", function () {
      newChatOfferState.newChatAttachments = newChatOfferState.newChatAttachments.filter(function (item) { return item.id !== attachment.id; });
      renderNewChatAttachments();
      renderNewChatState();
    });
    chip.append(thumb, remove);
    strip.append(chip);
  }
}

/** Starts the chat: made on the server as the computer makes one (its
 *  members, the line it starts with, its title), then the first message
 *  with its pictures, each its own operation, in that order. */
async function startNewChat() {
  const input = document.getElementById("new-chat-input");
  const offer = newChatOffer && newChatOffer.options;
  const shared = mobileSharedRules();
  const text = input ? input.value.trim() : "";
  const attachments = newChatOfferState.newChatAttachments.map(function (attachment) {
    return { filename: attachment.filename, mimeType: attachment.mimeType, dataBase64: attachment.dataBase64 };
  });
  // As on the computer, a picture on its own starts a chat.
  if (!offer || offer.unavailable || (!text && attachments.length === 0) || !shared || newChatOfferState.newChatStarting) return;
  // In the sessions view the chat is made with its main session alone, on
  // what the chip chose: no member is picked, an @ in the text included.
  const sessionsView = newChatSessionsView(offer);
  // Each member it gets, chosen or named with @, must be one the computer
  // could add now, as the computer's New chat checks them all.
  const picked = sessionsView ? [] : shared.newChatPickedMembers({ members: offer.members, chosenConfigIds: Array.from(newChatChosen), firstMessage: text });
  const blocked = picked.find(function (member) { return member.unavailable || member.machineUnavailable; });
  if (blocked) {
    renderNewChat(blocked.unavailable || blocked.machineUnavailable);
    return;
  }
  // The main session on a machine that does not have this project would
  // wait for the computer to copy it there, as a member would.
  const mainChoice = sessionsView ? newChatMainSelection(offer) : undefined;
  if (mainChoice && mainChoice.homeMachineId && !newChatMachineFitsProject(mainChoice.homeMachineId)) {
    const machineName = (newChatMachineList().find(function (item) { return item.id === mainChoice.homeMachineId; }) || {}).name || "That machine";
    renderNewChat(machineName + " does not have this project. Choose a project it has, No project, or This computer.");
    return;
  }
  // Named with @, a member whose machine does not have this project would
  // wait for the computer to copy it there.
  const elsewhere = picked.find(function (member) { return !shared.newChatMemberFitsProject(member, newChatOfferState.newChatProject); });
  if (elsewhere) {
    const elsewhereMachine = elsewhere.machineId || elsewhere.participant.homeMachineId;
    const machine = elsewhereMachine && newChatOffer.machines[elsewhereMachine];
    renderNewChat("@" + elsewhere.participant.handle + " runs on " + (machine || "a cloud machine") +
      ", which does not have this project. Choose a project it has, or No project.");
    return;
  }
  newChatOfferState.newChatStarting = true;
  renderNewChatState();
  const conversationId = createEventId();
  let listed = false;
  try {
    const createdAt = nowIso();
    // The main session leads, as on the computer (passed under both names
    // the shared rule has known it by).
    const offeredLead = newChatLead(offer);
    const selection = sessionsView ? newChatMainSelection(offer) : undefined;
    const lead = selection && typeof shared.newChatMainSessionFor === "function"
      ? shared.newChatMainSessionFor(offeredLead, offer.mainSessionProviders, { kind: selection.provider.kind, hostId: selection.provider.hostId,
        model: selection.model, reasoningEffort: selection.effort, access: selection.access, plan: selection.plan, homeMachineId: selection.homeMachineId })
      : offeredLead;
    const participants = shared.newChatParticipants({
      assistant: lead, mainSession: lead, members: sessionsView ? [] : offer.members, chosenConfigIds: sessionsView ? [] : Array.from(newChatChosen),
      firstMessage: sessionsView ? "" : text, newId: createEventId,
      // Its rights follow the project as on the computer: it reads the
      // project only when the chat has one.
      project: newChatOfferState.newChatProject || ""
    });
    // The chat's main session, and the view it opens in: the one her
    // computer starts new chats in, else the sessions view.
    const mainSession = participants.find(isMainSessionMember);
    const chatView = offer.defaultChatView === "classic" || offer.defaultChatView === "sessions" ? offer.defaultChatView : "sessions";
    const sessionsFields = mainSession ? { mainSessionParticipantId: mainSession.id, chatView: chatView } : {};
    const repoPath = newChatOfferState.newChatProject || undefined;
    const title = shared.newChatTitle(text, attachments.length ? attachments[0].filename : undefined);
    // In the list at once, as the computer's sidebar shows a chat it made
    // (the first message finds its members there).
    listed = true;
    noteOwnChat(conversationId);
    saveStartedChats([{
      id: conversationId, title: title, group: shared.mobileChatGroupLabel(repoPath), snippet: shared.mobileSnippet(text), who: "you:", updatedAt: createdAt,
      running: false, startedHere: true, deviceId: (loadPairing() || {}).deviceId,
      ...(mainSession ? { ...sessionsFields, canSwitchView: true } : {}),
      participants: participants.map(function (participant) { return "@" + participant.handle; }).slice(0, 4),
      members: participants.map(function (participant) {
        const assistant = participant.roleConfigId === "administrator";
        return normalizeMobileMember({ id: participant.id, handle: participant.handle, mentionHandle: participant.handle,
          displayName: assistant ? "Chat Assistant" : "@" + participant.handle, roleLabel: newChatOffer.roles[participant.roleConfigId] || "",
          roleConfigId: participant.roleConfigId, kind: participant.kind, avatarId: participant.avatarId, isAssistant: assistant,
          homeMachineId: participant.homeMachineId, cloudRun: participant.cloudRun,
          homeMachineName: participant.homeMachineId ? newChatOffer.machines[participant.homeMachineId] : undefined });
      }).filter(Boolean)
    }].concat(loadStartedChats()));
    const create = await createOutboxEvent({
      conversationId: conversationId, kind: "conversation.create", createdAt: createdAt,
      payload: { conversation: { title: title, kind: "chat", createdAt: createdAt, ...(repoPath ? { repoPath: repoPath } : {}),
        metadata: { participants: participants, ...sessionsFields } } }
    });
    const introId = createEventId();
    const intro = await createOutboxEvent({
      eventId: introId, conversationId: conversationId, kind: "message.system", createdAt: createdAt, dependsOn: create.eventId,
      payload: { message: { id: introId, role: "system", content: shared.newChatIntro(participants.map(function (participant) { return participant.handle; })),
        createdAt: createdAt, status: "done", metadata: { threadId: "system" } } }
    });
    // The pictures travel as the chat's composer sends them: put up on the
    // server first, then named by the message.
    const message = await messageOutboxEntries({ conversationId: conversationId, content: text, dependsOn: create.eventId,
      ...(attachments.length ? { payload: { content: text, attachments: attachments } } : {}) });
    // One transaction: the chat is never queued without its first message.
    await putOutboxEntries([create, intro].concat(message));
    listed = false;
  } catch (error) {
    // Nothing was queued: the chat is not in the list, and the screen says why.
    if (listed) forgetStartedChat(conversationId);
    newChatOfferState.newChatStarting = false;
    renderNewChat("Could not start the chat: " + (error && error.message ? error.message : String(error)));
    return;
  }
  newChatOfferState.newChatStarting = false;
  if (input) input.value = "";
  newChatOfferState.newChatMainChoice = undefined;
  newChatOfferState.newChatAttachments = [];
  renderNewChatAttachments();
  closeNewChat();
  renderNewChat("");
  await openConversation(conversationId);
  void sendNow();
}

/** What an @ in the first message can name: the main session and each
 *  member this chat can have, as the computer's New chat lists them. */
function newChatMentionMembers() {
  const offer = newChatOffer && newChatOffer.options;
  // The sessions view offers no members to name (the computer's neither).
  if (!offer || newChatSessionsView(offer)) return [];
  const option = function (participant, configId) {
    return { handle: participant.handle, mentionHandle: participant.handle, displayName: newChatMemberName(participant),
      roleLabel: newChatMemberRoleLine(participant),
      participant: participant, configId: configId };
  };
  return [option(newChatLead(offer))].concat(newChatVisibleMembers(offer)
    .filter(function (member) { return !member.unavailable && !member.machineUnavailable; })
    .map(function (member) { return option(member.participant, member.configId); }));
}

export function closeNewChatMentions() {
  const menu = document.getElementById("new-chat-mention-menu");
  const input = document.getElementById("new-chat-input");
  if (menu) {
    menu.hidden = true;
    menu.replaceChildren();
  }
  newChatOfferState.newChatMentionText = undefined;
  if (input) input.setAttribute("aria-expanded", "false");
}

/** The @ list for what is typed before the caret; picking a member writes
 *  its handle and adds it to the chat, as on the computer. */
function renderNewChatMentions() {
  const menu = document.getElementById("new-chat-mention-menu");
  const input = document.getElementById("new-chat-input");
  if (!menu || !input) return;
  const caret = typeof input.selectionStart === "number" ? input.selectionStart : input.value.length;
  const typed = input.value.slice(0, caret);
  // Every member that matches, as the computer's list and the chat's own @
  // list offer them: the list scrolls past what fits (the User, 2026-10-31).
  const options = document.activeElement === input ? mentionOptions(typed, newChatMentionMembers()) : [];
  if (options.length === 0) {
    closeNewChatMentions();
    return;
  }
  // Opened, or narrowed by what was typed: from the first match, not from
  // where an earlier list was scrolled to.
  const fromTop = menu.hidden || typed !== newChatOfferState.newChatMentionText;
  newChatOfferState.newChatMentionText = typed;
  menu.replaceChildren();
  const title = document.createElement("div");
  title.className = "mobile-mention-title";
  title.textContent = "Members";
  menu.append(title);
  for (const member of options) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "mobile-mention-option";
    row.dataset.handle = member.handle;
    row.setAttribute("role", "option");
    // The field keeps the keyboard while a member is picked.
    row.addEventListener("pointerdown", function (event) { event.preventDefault(); });
    row.addEventListener("click", function () {
      const at = typeof input.selectionStart === "number" ? input.selectionStart : input.value.length;
      const edit = replaceMentionAtCaret(input.value, member.mentionHandle, at);
      input.value = edit.value;
      input.focus();
      input.setSelectionRange(edit.caret, edit.caret);
      if (member.configId) newChatChosen.add(member.configId);
      closeNewChatMentions();
      renderNewChat("");
    });
    const copy = document.createElement("span");
    copy.className = "mobile-mention-copy";
    const name = document.createElement("strong");
    name.textContent = member.displayName;
    const role = document.createElement("span");
    role.textContent = member.roleLabel;
    copy.append(name, role);
    row.append(newChatAvatar(member.participant), copy);
    menu.append(row);
  }
  menu.hidden = false;
  if (fromTop) menu.scrollTop = 0;
  input.setAttribute("aria-expanded", "true");
}

export function wireNewChat() {
  const button = document.getElementById("new-chat-button");
  const screen = document.getElementById("new-chat-screen");
  const close = document.getElementById("new-chat-close");
  const input = document.getElementById("new-chat-input");
  const start = document.getElementById("new-chat-start");
  const attach = document.getElementById("new-chat-attach");
  const imageInput = document.getElementById("new-chat-image-input");
  // The bar is under a chat's composer too: New chat from there leaves the
  // chat, so what arrives in it while New chat is up is not taken as read.
  button?.addEventListener("click", function () {
    const leaving = Boolean(selectedConversationId());
    leaveOpenChat();
    void openNewChat();
    if (leaving) void render();
  });
  // The menu button opens the chats, from wherever New chat was opened
  // (the User, 2026-11-01): it is the way off this screen, not a cancel.
  close?.addEventListener("click", function () { void switchHomeTab("chats"); });
  screen?.addEventListener("click", function (event) {
    if (event.target instanceof Element && event.target.closest("[data-new-chat-picker-close]")) closeNewChatPickers();
  });
  document.getElementById("new-chat-project")?.addEventListener("click", function () { openNewChatPicker("new-chat-projects-sheet"); });
  document.getElementById("new-chat-members-button")?.addEventListener("click", function () { openNewChatPicker("new-chat-members-sheet"); });
  document.getElementById("new-chat-model-button")?.addEventListener("click", function () { openNewChatPicker("new-chat-model-sheet"); });
  input?.addEventListener("input", function () {
    renderNewChatState();
    renderNewChatMentions();
  });
  // The caret moved (a tap, an arrow key): the list follows what is before it.
  input?.addEventListener("keyup", renderNewChatMentions);
  input?.addEventListener("click", renderNewChatMentions);
  // Gone once the field has really lost the focus: a tap on the list keeps
  // it (and where a browser moves it there, the pick lands first).
  input?.addEventListener("blur", function () {
    setTimeout(function () { if (document.activeElement !== input) closeNewChatMentions(); }, 200);
  });
  start?.addEventListener("click", function () { void startNewChat(); });
  if (attach && imageInput) {
    attach.addEventListener("click", function () { imageInput.click(); });
    imageInput.addEventListener("change", async function () {
      const files = Array.from(imageInput.files || []);
      // Clearing lets the same file be picked again after removing it.
      imageInput.value = "";
      newChatOfferState.newChatPreparing += 1;
      renderNewChatState();
      let rejected = [];
      try {
        rejected = await addPendingAttachments(files, function () { return newChatOfferState.newChatAttachments; });
      } finally {
        newChatOfferState.newChatPreparing -= 1;
      }
      renderNewChatAttachments();
      // A refusal is said; a later pick that went through clears an earlier
      // refusal, and nothing else that is said.
      if (rejected.length > 0) renderNewChat(NEW_CHAT_REJECTED_PREFIX + rejected.join("; "));
      else if (String(newChatOfferState.newChatSaid || "").indexOf(NEW_CHAT_REJECTED_PREFIX) === 0) renderNewChat("");
      else renderNewChatState();
    });
  }
}
