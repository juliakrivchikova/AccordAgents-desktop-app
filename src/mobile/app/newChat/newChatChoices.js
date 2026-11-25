import { lineIcon } from "../activity/activityData.js";
import { avatarForMember, mobileSharedRules, paintAvatar } from "../members/avatars.js";
import { memberKindLabel } from "../members/membersSheet.js";
import { NEW_CHAT_CHECK_ICON, newChatChosen, newChatOffer, newChatOfferState } from "./newChatOffer.js";
import { newChatMemberName } from "./newChatPickers.js";
import { providerLogoElement } from "../sessions/sessionsStatus.js";

/** The saved members as the computer's New chat lists them: the most used
 *  first, the rest in the order they were saved. */
function newChatMemberOrder(members) {
  return members.map(function (member, index) { return { member: member, index: index }; })
    .sort(function (left, right) { return ((right.member.uses || 0) - (left.member.uses || 0)) || (left.index - right.index); })
    .map(function (item) { return item.member; });
}

/** The members this chat can have in its project (the User, 2026-10-30):
 *  a member that runs on a machine only where that machine has the
 *  project, or in a chat without one. Changing the project changes them. */
export function newChatVisibleMembers(offer) {
  const shared = mobileSharedRules();
  return newChatMemberOrder(offer.members).filter(function (member) {
    return !shared || typeof shared.newChatMemberFitsProject !== "function" || shared.newChatMemberFitsProject(member, newChatOfferState.newChatProject);
  });
}

/** A member chosen for one project and hidden in the next is not in the chat. */
export function pruneNewChatChosen() {
  const offer = newChatOffer && newChatOffer.options;
  if (!offer) return;
  const visible = new Set(newChatVisibleMembers(offer).map(function (member) { return member.configId; }));
  for (const configId of Array.from(newChatChosen)) {
    if (!visible.has(configId)) newChatChosen.delete(configId);
  }
}

/** The projects the computer offers, the one it would start in first even
 *  when it is not among them (a folder no chat is in yet). */
export function newChatProjectList(offer) {
  const projects = offer ? offer.projects.slice() : [];
  const preferred = offer && offer.defaultProject;
  if (preferred && !projects.some(function (project) { return project.path === preferred; })) {
    projects.unshift({ path: preferred, label: preferred.split(/[\\/]+/).filter(Boolean).pop() || preferred });
  }
  return projects;
}

/** Where a project is, as the User reads it: her home folder as "~". */
export function newChatProjectPlace(path) {
  return String(path || "").replace(/^\/Users\/[^/]+(?=\/|$)/, "~");
}

export function newChatCheck(chosen) {
  const check = document.createElement("span");
  check.className = "new-chat-check";
  check.setAttribute("aria-hidden", "true");
  if (chosen) check.append(lineIcon(NEW_CHAT_CHECK_ICON, 14));
  return check;
}

export function newChatAvatar(participant) {
  // The main session has no avatar picture: its mark is its provider's
  // logo, as in the sessions view a new chat opens in (and on the desktop).
  if (isMainSessionMember(participant)) return providerLogoElement(participant.kind, "is-mini", { tile: true });
  const avatar = document.createElement("span");
  avatar.className = "mobile-mention-avatar";
  const assistant = participant.roleConfigId === "administrator";
  paintAvatar(avatar, avatarForMember({ id: participant.id, handle: participant.handle, kind: participant.kind, avatarId: participant.avatarId,
    displayName: newChatMemberName(participant), isAssistant: assistant }), undefined);
  return avatar;
}

export const MAIN_SESSION_ROLE = "main-session";

/** The member every new chat starts with, first: its main session
 *  (docs/main-session.md). A server whose computer has not updated yet
 *  offers only its Chat Assistant, and that is what such a chat gets. */
export function newChatLead(offer) {
  return offer ? offer.mainSession || offer.assistant : undefined;
}

export function isMainSessionMember(participant) {
  return Boolean(participant) && participant.roleConfigId === MAIN_SESSION_ROLE;
}

/** A new chat that opens in the sessions view (the computer's Settings →
 *  General; unset: sessions) has no members on New chat: its chip chooses
 *  the main session's provider, model and effort, as on the computer (the
 *  User, 2026-11-21: "как в T3, выбираешь просто провайдера и модель"). */
export function newChatSessionsView(offer) {
  return Boolean(offer) && offer.defaultChatView !== "classic" && isMainSessionMember(newChatLead(offer));
}

/** The providers the chip offers: the computer's list, else (a computer
 *  from before) the offered main session's own. */
export function newChatProviders(offer) {
  if (offer && Array.isArray(offer.mainSessionProviders) && offer.mainSessionProviders.length > 0) return offer.mainSessionProviders;
  const lead = newChatLead(offer);
  return lead ? [{ kind: lead.kind, label: memberKindLabel(lead.kind), defaultModelLabel: memberKindLabel(lead.kind), models: [], efforts: [] }] : [];
}

/** What the chip shows chosen: the choice while the offer still has its
 *  provider, else the offered main session's provider with its CLI's own
 *  model and effort. */
export function newChatMainSelection(offer) {
  const providers = newChatProviders(offer);
  const lead = newChatLead(offer);
  const same = function (item, choice) { return item.kind === choice.kind && (item.hostId || "") === (choice.hostId || ""); };
  const chosen = newChatOfferState.newChatMainChoice && providers.find(function (item) { return same(item, newChatOfferState.newChatMainChoice); });
  const provider = chosen || (lead && providers.find(function (item) { return same(item, { kind: lead.kind, hostId: lead.hostId }); })) || providers[0];
  if (!provider) return undefined;
  // What she chose here for this chat; else how the computer's Settings →
  // General → New chats starts a new chat, carried by the offered main
  // session (its model, effort and mode on its own provider, where it runs
  // on any), as the computer's New chat starts from them.
  const rules = mobileSharedRules();
  const base = rules && typeof rules.newChatLeadStart === "function" ? rules.newChatLeadStart(lead, provider) : {};
  const pick = function (key) {
    return chosen && Object.prototype.hasOwnProperty.call(newChatOfferState.newChatMainChoice, key) ? newChatOfferState.newChatMainChoice[key] : base[key];
  };
  // The computer's own model and effort stand even when the offer's list
  // lacks them (not read yet after a restart): it runs them (newChatMainSessionFor).
  const modelWanted = pick("model");
  const model = modelWanted && (provider.models.some(function (item) { return item.id === modelWanted; }) || modelWanted === base.model) ? modelWanted : undefined;
  const modelEntry = model ? provider.models.find(function (item) { return item.id === model; }) : undefined;
  const efforts = (modelEntry && modelEntry.efforts) || provider.efforts || [];
  const effortWanted = pick("reasoningEffort");
  const effort = effortWanted && (efforts.some(function (item) { return item.id === effortWanted; }) || effortWanted === base.reasoningEffort) ? effortWanted : undefined;
  // Its CLI's mode in the CLI's own terms, the computer's picker's modes and
  // words (chatAccessModes): the one its CLI starts in until one is chosen.
  // Where it runs: one of the machines, once there is one; else this computer.
  const homeWanted = pick("homeMachineId");
  const homeMachineId = homeWanted && newChatMachineList().some(function (item) { return item.id === homeWanted; }) ? homeWanted : undefined;
  // Codex's Full Access and Plan mode only where they run: a computer that
  // offers them, and a machine whose program does (the computer's offer).
  const modes = offer && offer.cliModes;
  const modesHere = Boolean(modes) && (!homeMachineId || Boolean(modes.machines && modes.machines[homeMachineId]));
  const accessSet = newChatAccessSet(provider.kind);
  // What the User's own config starts the CLI in where it runs: this
  // computer's (with its provider), or the machine's (it reads its own).
  const start = newChatStartDefaults(offer, provider, homeMachineId);
  // The modes the computer's picker lists, and one it lists only while it
  // is the mode (Codex's Read Only) when her config starts the CLI in it.
  const shared = mobileSharedRules();
  const startOption = start && start.access && shared && typeof shared.startChatAccessOption === "function" ? shared.startChatAccessOption(provider.kind, start.access) : undefined;
  const startHidden = startOption && startOption.hidden ? startOption : undefined;
  const accessOptions = newChatAccessOptions(provider.kind).concat(startHidden ? [startHidden] : [])
    .filter(function (item) { return modesHere || item.agentMode !== "full-access"; });
  const defaultAccess = accessOptions.length > 0 ? newChatDefaultAccess(provider.kind, start && start.access, accessOptions) : undefined;
  // A mode she chose (or the computer's Settings start a new chat in);
  // none: the one her config starts the CLI in there, which follows where
  // it runs until she chooses one.
  const accessWanted = pick("access");
  const accessChosen = accessWanted && accessOptions.some(function (item) { return item.id === accessWanted; }) ? accessWanted : undefined;
  const access = accessChosen || defaultAccess;
  // Codex's Plan mode: its own toggle beside the permissions, as on the computer.
  const planOffered = Boolean(accessSet && accessSet.plan && modesHere);
  const plan = Boolean(chosen && newChatOfferState.newChatMainChoice.plan && planOffered);
  // None chosen: the model and effort her config starts it on there.
  const startModelLabel = !model && !provider.hostId && homeMachineId && start && start.modelLabel ? start.modelLabel : undefined;
  const startEffort = !effort && !model && !provider.hostId && start && start.reasoningEffort &&
    efforts.some(function (item) { return item.id === start.reasoningEffort; }) ? start.reasoningEffort : undefined;
  const shownEffort = effort || startEffort;
  return { provider: provider, model: model, modelLabel: modelEntry ? modelEntry.label : model || startModelLabel || provider.defaultModelLabel, efforts: efforts,
    effort: effort, effortLabel: shownEffort ? (efforts.find(function (item) { return item.id === shownEffort; }) || { label: shownEffort }).label : undefined,
    startEffortLabel: startEffort ? (efforts.find(function (item) { return item.id === startEffort; }) || {}).label : undefined,
    accessOptions: accessOptions, access: access, accessChosen: accessChosen, accessSet: accessSet, planOffered: planOffered, plan: plan, homeMachineId: homeMachineId };
}

/** What the User's own config starts a provider's CLI in where the main
 *  session runs (src/shared/cliStartDefaults.ts): the computer's, said
 *  with each provider; a machine's, said by its last hello. */
function newChatStartDefaults(offer, provider, homeMachineId) {
  if (homeMachineId) {
    const machines = offer && offer.cliStart && offer.cliStart.machines;
    const ofMachine = machines && machines[homeMachineId];
    return ofMachine && ofMachine[provider.kind] ? ofMachine[provider.kind] : undefined;
  }
  return provider && provider.start ? provider.start : undefined;
}

/** A CLI's modes as its own menu titles them (and Codex's Plan mode, and
 *  what Antigravity cannot do here), one shared table with the computer. */
function newChatAccessSet(kind) {
  const shared = mobileSharedRules();
  return shared && typeof shared.chatAccessModeSet === "function" ? shared.chatAccessModeSet(kind) : undefined;
}

/** The modes the computer's picker lists for this CLI (one shared list). */
function newChatAccessOptions(kind) {
  const shared = mobileSharedRules();
  return shared && typeof shared.chatAccessOptions === "function" ? shared.chatAccessOptions(kind) : [];
}

/** The mode a new main session starts in: the one the User's config starts
 *  its CLI in where it runs, when offered; else the CLI's built-in one. */
function newChatDefaultAccess(kind, startAccess, offered) {
  const shared = mobileSharedRules();
  const option = shared && typeof shared.startChatAccessOption === "function"
    ? shared.startChatAccessOption(kind, startAccess)
    : shared && typeof shared.defaultChatAccessOption === "function" ? shared.defaultChatAccessOption(kind) : undefined;
  if (option && (!offered || offered.some(function (item) { return item.id === option.id; }))) return option.id;
  const fallback = shared && typeof shared.defaultChatAccessOption === "function" ? shared.defaultChatAccessOption(kind) : undefined;
  return fallback ? fallback.id : undefined;
}

/** The machines the server knows, by name: where a main session can run
 *  besides this computer. None: New chat does not ask where it runs. */
export function newChatMachineList() {
  const machines = newChatOffer && newChatOffer.machines ? newChatOffer.machines : {};
  return Object.keys(machines).map(function (id) { return { id: id, name: machines[id] || "Machine" }; });
}

/** The projects a machine has, as the computer said for the members that
 *  run there (none known: it is not held to a project). */
function newChatMachineProjects(machineId) {
  const offer = newChatOffer && newChatOffer.options;
  const member = offer && (offer.members || []).find(function (item) {
    return Array.isArray(item.projects) && (item.machineId || (item.participant && item.participant.homeMachineId)) === machineId;
  });
  return member ? member.projects : undefined;
}

/** Whether a machine has the chat's project (or the chat has none), by the
 *  rule members on machines are held to. */
export function newChatMachineFitsProject(machineId) {
  const shared = mobileSharedRules();
  if (!machineId || !shared || typeof shared.newChatMemberFitsProject !== "function") return true;
  return shared.newChatMemberFitsProject({ projects: newChatMachineProjects(machineId) }, newChatOfferState.newChatProject);
}
