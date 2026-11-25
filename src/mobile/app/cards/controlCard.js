import { answerControlCard, cardOutcome, cardSentState, controlCardAnswering, controlCardErrors, isCardLocked } from "./cardAnswers.js";
import { compactCardElement } from "./cardRows.js";
import { appendCardWho, cardAppText } from "./cardText.js";
import { blurWithin, choiceCardBody } from "./choiceCard.js";
import { cardChatScopeTicked } from "./tailCards.js";
import { applyDockAfterTap, applyDockKeepingReader } from "../shell/home.js";
import { renderMessageContent } from "../text/messageText.js";

export function controlCardElement(card) {
  if (card.waiting === true) {
    // Answered and not done yet: what was approved and what it waits for.
    return compactCardElement(card, card.outcome || "", "control-card-folded control-card-waiting", "");
  }
  // Answered here and on its way: folded at once to what was answered, and
  // faded until the desktop says so (the User, 2026-09-24).
  if (cardOnItsWay(card)) {
    // Her answer, not yet the member's: "Answered" is what the desktop says
    // once it has it. A mark from before answers were kept folds bare.
    const node = compactCardElement(card, cardOutcome(card.id) || "", "control-card-folded is-on-its-way", "Your answer: ");
    node.append(onItsWayNote());
    return node;
  }
  const wrap = document.createElement("article");
  wrap.className = "control-card";
  wrap.dataset.cardId = card.id;
  wrap.dataset.cardKind = card.kind;

  const head = document.createElement("div");
  head.className = "control-card-head";
  const title = document.createElement("span");
  title.className = "control-card-title";
  title.textContent = cardAppText(card, card.title, true) || (card.kind === "permission" ? "Permission request" : "Choice");
  head.append(title);
  appendCardWho(head, card);
  wrap.append(head);

  if (card.summary) {
    const summary = document.createElement("p");
    summary.className = "control-card-summary";
    summary.textContent = cardAppText(card, card.summary, true);
    wrap.append(summary);
  }

  // A connector sign-in: the page the member's CLI gave, opened here.
  if (typeof card.signInUrl === "string" && /^https?:\/\//i.test(card.signInUrl)) {
    const signIn = document.createElement("a");
    signIn.className = "control-card-option control-card-sign-in";
    signIn.href = card.signInUrl;
    signIn.target = "_blank";
    signIn.rel = "noopener noreferrer";
    signIn.textContent = "Sign in";
    wrap.append(signIn);
  }

  const sent = isCardLocked(card.id) || controlCardAnswering.has(card.id);
  if (card.kind === "choice") {
    choiceCardBody(wrap, card, sent);
    appendCardState(wrap, card);
    return wrap;
  }
  if (card.chatScopeLabel && card.primaryOptionId) {
    permissionCardWithBox(wrap, card, sent);
    appendCardState(wrap, card);
    return wrap;
  }
  if (card.plan) {
    planCardBody(wrap, card, sent);
    appendCardState(wrap, card);
    return wrap;
  }
  const options = document.createElement("div");
  options.className = "control-card-options";
  for (const option of Array.isArray(card.options) ? card.options : []) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "control-card-option";
    button.dataset.optionId = option.id;
    button.textContent = cardAppText(card, option.label) || option.id;
    button.disabled = sent;
    button.addEventListener("click", function () {
      void answerControlCard(card, { optionId: option.id });
    });
    options.append(button);
  }
  if (card.allowsCancel) {
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "control-card-option";
    cancel.dataset.optionId = "cancel";
    cancel.textContent = "Cancel";
    cancel.disabled = sent;
    cancel.addEventListener("click", function () {
      void answerControlCard(card, { cancel: true });
    });
    options.append(cancel);
  }
  wrap.append(options);
  appendCardState(wrap, card);
  return wrap;
}

/** A permission card laid out as the desktop's compaction card is: its
 *  context meter and what the summary keeps, then the "for the rest of
 *  the chat" box on the left and its answers on the right, the primary
 *  one last and filled. */
function permissionCardWithBox(wrap, card, sent) {
  wrap.classList.add("control-card-boxed");
  if (card.meter && typeof card.meter.percentage === "number") {
    const meter = document.createElement("div");
    meter.className = "control-card-meter";
    const bar = document.createElement("div");
    bar.className = "control-card-meter-bar";
    bar.setAttribute("role", "meter");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    bar.setAttribute("aria-valuenow", String(card.meter.percentage));
    bar.setAttribute("aria-label", card.meter.name || "Context used");
    bar.setAttribute("aria-valuetext", card.meter.label || "");
    const fill = document.createElement("span");
    fill.style.width = Math.max(0, Math.min(100, card.meter.percentage)) + "%";
    bar.append(fill);
    const label = document.createElement("span");
    label.className = "control-card-meter-label";
    label.setAttribute("aria-hidden", "true");
    label.textContent = card.meter.label || "";
    meter.append(bar, label);
    wrap.append(meter);
  }
  if (card.keeps && card.keeps.text) {
    const keeps = document.createElement("p");
    keeps.className = "control-card-keeps";
    const lead = document.createElement("b");
    lead.textContent = card.keeps.label || "";
    keeps.append(lead, document.createTextNode(" " + card.keeps.text));
    wrap.append(keeps);
  }
  const box = document.createElement("label");
  box.className = "control-card-box";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = cardChatScopeTicked.has(card.id);
  input.disabled = sent;
  input.addEventListener("change", function () {
    if (input.checked) cardChatScopeTicked.add(card.id);
    else cardChatScopeTicked.delete(card.id);
  });
  const boxText = document.createElement("span");
  boxText.textContent = card.chatScopeLabel;
  box.append(input, boxText);
  wrap.append(box);
  const actions = document.createElement("div");
  actions.className = "control-card-actions";
  const options = Array.isArray(card.options) ? card.options : [];
  const ordered = options.filter(function (option) { return option.id !== card.primaryOptionId; })
    .concat(options.filter(function (option) { return option.id === card.primaryOptionId; }));
  for (const option of ordered) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = option.id === card.primaryOptionId ? "control-card-submit" : "control-card-cancel";
    button.dataset.optionId = option.id;
    button.textContent = cardAppText(card, option.label) || option.id;
    button.disabled = sent;
    button.addEventListener("click", function () {
      void answerControlCard(card, { optionId: option.id, chatScope: cardChatScopeTicked.has(card.id) });
    });
    actions.append(button);
  }
  wrap.append(actions);
}

// Words typed for "No, keep planning" and not sent yet, by card: kept when
// the card is drawn again (in the chat and on Activity alike).
const planFeedbackDrafts = new Map();

/**
 * Claude Code's plan approval, as the CLI shows it ("Ready to code?" is the
 * card's title): "Here is Claude's plan:", the plan, the CLI's question,
 * then its rows. A Yes answers at once, as a permission's options do; "No,
 * keep planning" sends what is typed in its field ("Tell Claude what to
 * change"), the field taken by the finger.
 */
function planCardBody(wrap, card, sent) {
  const plan = card.plan;
  const intro = document.createElement("p");
  intro.className = "control-card-summary";
  intro.textContent = plan.intro;
  const body = document.createElement("div");
  body.className = "control-card-plan";
  if (plan.isPlan) {
    const content = document.createElement("div");
    content.className = "message-content markdown-text";
    renderMessageContent(content, plan.text);
    body.append(content);
  } else {
    body.textContent = plan.text;
  }
  const question = document.createElement("p");
  question.className = "control-card-summary";
  question.textContent = plan.question;
  wrap.append(intro, body, question);

  const options = document.createElement("div");
  options.className = "control-card-options";
  const feedbackOption = (Array.isArray(card.options) ? card.options : []).find(function (option) { return option.id === plan.feedbackOptionId; });
  for (const option of Array.isArray(card.options) ? card.options : []) {
    if (option === feedbackOption) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "control-card-option";
    button.dataset.optionId = option.id;
    button.textContent = option.label || option.id;
    button.disabled = sent;
    button.addEventListener("click", function () {
      blurWithin(wrap);
      void answerControlCard(card, { optionId: option.id });
    });
    options.append(button);
  }
  wrap.append(options);
  if (!feedbackOption) return;
  const panel = document.createElement("label");
  panel.className = "control-card-text control-card-plan-feedback";
  const field = document.createElement("textarea");
  field.rows = 2;
  field.placeholder = plan.feedbackPlaceholder;
  field.setAttribute("aria-label", feedbackOption.label);
  field.value = planFeedbackDrafts.get(card.id) || "";
  field.disabled = sent;
  field.addEventListener("focus", applyDockKeepingReader);
  field.addEventListener("blur", applyDockAfterTap);
  field.addEventListener("input", function () { planFeedbackDrafts.set(card.id, field.value); });
  panel.append(field);
  const keep = document.createElement("div");
  keep.className = "control-card-options";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "control-card-option";
  button.dataset.optionId = feedbackOption.id;
  button.textContent = feedbackOption.label || feedbackOption.id;
  button.disabled = sent;
  button.addEventListener("click", function () {
    blurWithin(wrap);
    void answerControlCard(card, { optionId: feedbackOption.id, feedback: field.value }).then(function () {
      if (isCardLocked(card.id)) planFeedbackDrafts.delete(card.id);
    });
  });
  keep.append(button);
  wrap.append(panel, keep);
}

/** What a card says under its options. An answer on its way only fades the
 *  card: how far it has got is detail the User does not need (the User,
 *  2026-09-24). What she can act on is still said: a failure, or that she
 *  can answer again. */
export function cardStateText(card) {
  const failure = controlCardErrors.get(card.id);
  if (failure) return failure;
  const sentState = cardSentState(card.id);
  return sentState && !sentState.locked ? sentState.text : "";
}

/** The fade, said to a screen reader: its controls are dead for a reason. */
export function onItsWayNote() {
  const note = document.createElement("span");
  note.className = "sr-only";
  note.textContent = "Your answer is on its way.";
  return note;
}

export function cardOnItsWay(card) {
  return !controlCardErrors.has(card.id) && (isCardLocked(card.id) || controlCardAnswering.has(card.id));
}

function appendCardState(wrap, card) {
  const state = document.createElement("p");
  state.className = "control-card-state";
  state.textContent = cardStateText(card);
  state.hidden = !state.textContent;
  wrap.append(state);
}
