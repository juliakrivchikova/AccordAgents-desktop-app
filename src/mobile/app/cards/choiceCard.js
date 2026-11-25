import { lineIcon } from "../activity/activityData.js";
import { answerControlCard, controlCardAnswering, isCardLocked } from "./cardAnswers.js";
import { cardRequesterLabel } from "./cardText.js";
import { applyDockAfterTap, applyDockKeepingReader } from "../shell/home.js";

// What was picked on a choice and not sent yet, by card. Outside the card:
// the same card is drawn in the chat and on Activity, and drawn again when
// it changes, and a half-written answer must survive both.
const CHOICE_CUSTOM_ID = "custom";

// What the desktop calls your own answer. Sent without it, an own answer was
// read as an option it does not have and refused (the User, 2026-10-01).
const CHOICE_CUSTOM_OPTION_ID = "__custom__";

export const choiceDrafts = new Map();

// Every drawing of a choice now on screen, by card: a pick made in one (the
// chat, say) shows in the other (Activity) instead of leaving it showing a
// pick its Submit would not send.
export const choiceViews = new Map();

function syncChoiceViews(cardId) {
  const views = choiceViews.get(cardId);
  if (!views) return;
  for (const view of Array.from(views)) {
    if (view.wrap.isConnected) view.update();
    else views.delete(view);
  }
  if (views.size === 0) choiceViews.delete(cardId);
}

function choiceDraft(card) {
  const options = Array.isArray(card.options) ? card.options : [];
  // What the pick was made against. A member that changes its options or
  // its recommendation asks a different question, and the pick starts over
  // from the new recommendation, as the desktop card's does.
  const asked = JSON.stringify([options.map(function (option) { return option.id; }), card.recommendedOptionId || ""]);
  let draft = choiceDrafts.get(card.id);
  if (!draft || draft.asked !== asked) {
    const recommended = options.some(function (option) { return option.id === card.recommendedOptionId; })
      ? card.recommendedOptionId : "";
    draft = { asked: asked, selected: recommended, customAnswer: "", note: "" };
    choiceDrafts.set(card.id, draft);
  }
  return draft;
}

/** A choice laid out as the desktop lays it out: every option numbered, with
 *  its description and the member's recommendation marked and picked up
 *  front, "Write your own answer" last, then Cancel and Submit. Picking only
 *  selects; Submit answers (the User, 2026-09-22), so a tap made while
 *  scrolling cannot answer for her. */
export function choiceCardBody(wrap, card, sent) {
  const draft = choiceDraft(card);
  const who = cardRequesterLabel(card) || "the member";
  const list = document.createElement("div");
  list.className = "control-card-choices";
  list.setAttribute("role", "radiogroup");
  list.setAttribute("aria-label", card.summary || card.title || "Choice");
  const rows = [];
  function choiceRow(id, marker, label, description, recommended) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "control-card-choice";
    row.setAttribute("role", "radio");
    row.dataset.optionId = id;
    row.disabled = sent;
    const num = document.createElement("span");
    num.className = "control-card-choice-num";
    num.setAttribute("aria-hidden", "true");
    num.append(marker);
    const body = document.createElement("span");
    body.className = "control-card-choice-body";
    const titleLine = document.createElement("span");
    titleLine.className = "control-card-choice-title";
    const strong = document.createElement("strong");
    strong.textContent = label;
    titleLine.append(strong);
    if (recommended) {
      const chip = document.createElement("small");
      chip.className = "control-card-recommended";
      chip.textContent = "Recommended";
      titleLine.append(chip);
    }
    body.append(titleLine);
    if (description) {
      const text = document.createElement("span");
      text.className = "control-card-choice-description";
      text.textContent = description;
      body.append(text);
    }
    row.append(num, body);
    // Picking only opens a field, the note's or your own answer's; the finger
    // takes it, as it takes the composer. Focused from script, a field came
    // up behind the iPhone's keyboard (the User, 2026-09-24).
    row.addEventListener("click", function () {
      draft.selected = id;
      changed();
      const opened = id === CHOICE_CUSTOM_ID ? answer.panel : note.panel;
      if (!opened.hidden) revealInCardScroller(opened);
    });
    rows.push(row);
    list.append(row);
  }
  (Array.isArray(card.options) ? card.options : []).forEach(function (option, index) {
    choiceRow(option.id, String(index + 1) + ".", option.label || option.id, option.description,
      option.id === card.recommendedOptionId);
  });
  if (card.allowsCustomAnswer) {
    choiceRow(CHOICE_CUSTOM_ID, lineIcon(["M12 20h9", "M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"], 15),
      "Write your own answer", "None of the suggestions fit: type your own direction for " + who + ".", false);
  }
  wrap.append(list);

  function textPanel(className, label, hint, placeholder, rowsCount, value, onInput) {
    const panel = document.createElement("label");
    panel.className = "control-card-text " + className;
    const caption = document.createElement("span");
    caption.className = "control-card-text-caption";
    const strong = document.createElement("strong");
    strong.textContent = label;
    const small = document.createElement("small");
    small.textContent = hint;
    caption.append(strong, small);
    const field = document.createElement("textarea");
    field.rows = rowsCount;
    field.placeholder = placeholder;
    field.value = value;
    field.disabled = sent;
    // The keyboard this field raises takes the bar with it, as the
    // composer's does, and gives it back once a tap has landed.
    field.addEventListener("focus", applyDockKeepingReader);
    field.addEventListener("blur", applyDockAfterTap);
    field.addEventListener("input", function () {
      onInput(field.value);
      changed();
    });
    panel.append(caption, field);
    wrap.append(panel);
    return { panel: panel, field: field };
  }
  const answer = textPanel("control-card-answer", "Your answer", "sent word for word to " + who,
    "Your own direction for " + who, 3, draft.customAnswer, function (value) { draft.customAnswer = value; });
  const answerField = answer.field;
  // The note is open under the picked option itself and taken by the finger,
  // as the composer is. Folded behind a link that focused it from script, it
  // came up behind the iPhone's keyboard, out of sight while typed; at the
  // foot of a long list it started below the fold (the User, 2026-09-24).
  const note = textPanel("control-card-note", "Add a note", "optional, " + who + " sees it with your pick",
    "Constraints, caveats or a question for " + who, 2, draft.note, function (value) { draft.note = value; });

  const actions = document.createElement("div");
  actions.className = "control-card-actions";
  const hint = document.createElement("span");
  hint.className = "control-card-hint";
  hint.textContent = "Type your answer to send it.";
  actions.append(hint);
  if (card.allowsCancel) {
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "control-card-cancel";
    cancel.dataset.optionId = "cancel";
    cancel.textContent = "Cancel";
    cancel.disabled = sent;
    cancel.addEventListener("click", function () {
      blurWithin(wrap);
      // A note typed before Cancel does not go with it, so it is not shown
      // under the sent card as if it had. Only a Cancel that is taken: one
      // tapped behind a Submit already on its way changes nothing.
      if (controlCardAnswering.has(card.id) || isCardLocked(card.id)) return;
      draft.cancelled = true;
      void answerControlCard(card, { cancel: true }).then(function () {
        if (!isCardLocked(card.id)) draft.cancelled = false;
      });
    });
    actions.append(cancel);
  }
  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "control-card-submit";
  submit.textContent = "Submit";
  submit.addEventListener("click", function () {
    const reply = choiceReply(card, draft);
    if (!reply) return;
    // Sent, so the keyboard has nothing left to do here, as after a message.
    blurWithin(wrap);
    if (!controlCardAnswering.has(card.id) && !isCardLocked(card.id)) draft.cancelled = false;
    // The draft stays until the desktop answers or withdraws the card: an
    // answer refused, or never taken, opens the card again with what was
    // picked and typed, not the recommendation and an empty box.
    void answerControlCard(card, reply);
  });
  actions.append(submit);
  wrap.append(actions);

  function changed() {
    syncChoiceViews(card.id);
  }

  function update() {
    for (const row of rows) {
      const on = row.dataset.optionId === draft.selected;
      row.setAttribute("aria-checked", on ? "true" : "false");
      row.classList.toggle("is-selected", on);
    }
    // Text typed in another drawing of this card, carried over here unless
    // this field is the one being typed in.
    for (const pair of [[answerField, draft.customAnswer], [note.field, draft.note]]) {
      if (document.activeElement !== pair[0] && pair[0].value !== pair[1]) pair[0].value = pair[1];
    }
    const custom = draft.selected === CHOICE_CUSTOM_ID;
    // Once sent, only a note that went with the answer is left to show.
    const noteShown = !custom && Boolean(draft.selected) &&
      (!sent || (!draft.cancelled && Boolean(draft.note.trim())));
    answer.panel.hidden = !custom;
    note.panel.hidden = !noteShown;
    // Moves with the pick, its text kept. Only when the pick changed: moving
    // a field takes its focus away.
    const pickedRow = rows.find(function (row) { return row.dataset.optionId === draft.selected; });
    if (noteShown && pickedRow && pickedRow.nextElementSibling !== note.panel) pickedRow.after(note.panel);
    hint.hidden = sent || !custom || Boolean(draft.customAnswer.trim());
    submit.disabled = sent || !choiceReply(card, draft);
  }
  update();
  // A drawing replaced since (the card changed, the view closed) is dropped
  // here, so the record stays as small as what is on screen.
  const views = choiceViews.get(card.id) || new Set();
  for (const view of Array.from(views)) {
    if (!view.wrap.isConnected) views.delete(view);
  }
  views.add({ wrap: wrap, update: update });
  choiceViews.set(card.id, views);
}

/** The answer a choice's draft makes, or undefined while it makes none. */
function choiceReply(card, draft) {
  if (draft.selected === CHOICE_CUSTOM_ID) {
    const text = draft.customAnswer.trim();
    return text ? { optionId: CHOICE_CUSTOM_OPTION_ID, customAnswer: text } : undefined;
  }
  const options = Array.isArray(card.options) ? card.options : [];
  if (!options.some(function (option) { return option.id === draft.selected; })) return undefined;
  const noteText = draft.note.trim();
  return { optionId: draft.selected, ...(noteText ? { note: noteText } : {}) };
}

/** A field a pick just opened, brought into sight in whatever scrolls the
 *  card, the chat or Activity: without focus and without moving the page,
 *  so the finger still takes it and iOS lifts a tapped field itself. Opened
 *  under a row at the bottom edge, it was below the fold with nothing to say so. */
function revealInCardScroller(node) {
  let scroller = node.parentElement;
  while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) {
    scroller = scroller.parentElement;
  }
  if (!scroller || scroller === document.body || scroller === document.documentElement) return;
  const overflow = node.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom + 8;
  if (overflow > 0) scroller.scrollTop += overflow;
}

export function blurWithin(node) {
  const active = document.activeElement;
  if (active && node.contains(active) && typeof active.blur === "function") active.blur();
}
