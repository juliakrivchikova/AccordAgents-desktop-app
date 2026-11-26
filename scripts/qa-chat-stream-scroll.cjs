// Scrolling up while an answer streams must leave the end of the chat at once.
// It used to re-pin the chat on every small step within the last 96 px, so each
// streamed chunk pulled the view back down and the timeline flickered.
//
// Open a chat in a debuggable app (docs/inspecting-the-desktop-app.md), then:
//   node scripts/qa-chat-stream-scroll.cjs [--port 9223] [--no-send] [--delta -60] [--steps 12] [--scroller ".chat-member-session-body"]
// It sends PROMPT (a long text answer, no tools) unless --no-send, waits for the
// answer to stream, turns the wheel up and records every frame. PASS: no frame
// moves the view back toward the end while the User scrolls up or rests.
// INCONCLUSIVE when the answer did not stream under the scroll, or the view did
// not start at the end: such a run proves nothing either way. Run it while no
// other member of the chat is working: "still streaming" is read from any Stop.
const { attach } = require("./cdp.cjs");

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const PORT = Number(arg("--port", 9222));
const DELTA = Number(arg("--delta", -60));
const STEPS = Number(arg("--steps", 12));
// The scroller under test: the chat's timeline, or a member's session panel.
const SCROLLER = JSON.stringify(arg("--scroller", ".chat-timeline"));
const PROMPT = process.env.PROMPT
  || "Without tools, text only: write a detailed essay of about 1200 words on the history of sailing ships, with headings, lists and short paragraphs.";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const app = await attach({ port: PORT });
  const ev = async (expression) => (await app.evaluate(expression)).result.value;
  const COMPOSER = `[data-testid="chat-main-composer"]`;
  if (!process.argv.includes("--no-send")) {
    // The prompt goes to the main session only; a member's panel streams what its member is given.
    if (SCROLLER !== JSON.stringify(".chat-timeline")) throw new Error("--scroller needs --no-send: start the member's answer first");
    // Never send what the User left in the composer along with the prompt.
    const draft = await ev(`(() => { const c = document.querySelector(${JSON.stringify(COMPOSER)}); return c ? c.querySelector("textarea").value.trim().length + c.querySelectorAll("img, [data-testid*=attachment], [data-testid*=mention]").length : -1; })()`);
    if (draft !== 0) throw new Error(draft < 0 ? "no chat composer on screen" : "the composer holds a draft or attachments: send nothing");
    await ev(`document.querySelector(${JSON.stringify(COMPOSER + " textarea")}).focus()`);
    await app.send("Input.insertText", { text: PROMPT });
    await sleep(200);
    await ev(`document.querySelector(${JSON.stringify(COMPOSER + " button[aria-label=\"Send message\"]")}).click()`);
  }
  // Streaming: the timeline keeps growing.
  let last = 0;
  let growing = 0;
  for (let i = 0; i < 240 && growing < 4; i += 1) {
    await sleep(500);
    const height = await ev(`document.querySelector(${SCROLLER}).scrollHeight`);
    growing = last > 0 && height > last + 20 ? growing + 1 : growing;
    last = height;
  }
  if (growing < 4) throw new Error("no answer streamed within two minutes");
  // Start at the end, where the chat follows the answer: scrolling back down there
  // follows it again.
  const box = await ev(`(() => { const r = document.querySelector(${SCROLLER}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const distance = `(() => { const t = document.querySelector(${SCROLLER}); return t.scrollHeight - t.scrollTop - t.clientHeight; })()`;
  for (let i = 0; i < 40 && (await ev(distance)) > 4; i += 1) {
    await app.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: 400 });
    await sleep(40);
  }
  await sleep(1500);
  await ev(`(() => {
    const timeline = document.querySelector(${SCROLLER});
    const frames = window.__streamScrollFrames = [];
    window.__streamScrollWheel = 0;
    if (!timeline.__streamScrollListening) {
      timeline.__streamScrollListening = true;
      timeline.addEventListener("wheel", () => { window.__streamScrollWheel += 1; }, { passive: true });
    }
    const loop = () => {
      frames.push({ st: timeline.scrollTop, sh: timeline.scrollHeight, ch: timeline.clientHeight, wheel: window.__streamScrollWheel });
      if (frames.length < 2000) window.__streamScrollRaf = requestAnimationFrame(loop);
    };
    window.__streamScrollRaf = requestAnimationFrame(loop);
  })()`);
  await sleep(300);
  for (let i = 0; i < STEPS; i += 1) {
    await app.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: DELTA });
    await sleep(30);
  }
  await sleep(3000);
  const frames = await ev(`(() => { cancelAnimationFrame(window.__streamScrollRaf); return window.__streamScrollFrames; })()`);
  // Still streaming when the recording ends: the growth under the scroll was the answer's,
  // not rows above measured taller as the view went up.
  const stillRunning = await ev(`Boolean(document.querySelector("[aria-label^='Stop']"))`);
  app.close();
  const first = frames.findIndex((frame) => frame.wheel > 0);
  // A pull toward the end: the position grows by more than the content above grew.
  let pulls = 0;
  for (let i = Math.max(1, first + 1); i < frames.length; i += 1) {
    const moved = frames[i].st - frames[i - 1].st;
    if (moved > 0.5 && moved > frames[i].sh - frames[i - 1].sh + 0.5) pulls += 1;
  }
  const end = frames.at(-1);
  const start = frames[Math.max(0, first - 1)];
  const result = {
    frames: frames.length,
    wheelEvents: end.wheel,
    startDistanceFromEnd: Math.round(start.sh - start.st - start.ch),
    pullsTowardEnd: pulls,
    distanceFromEnd: Math.round(end.sh - end.st - end.ch),
    contentGrew: end.sh - frames[Math.max(0, first)].sh,
    stillRunning
  };
  console.log(JSON.stringify(result));
  // The view must really have gone up under the wheel (not a child scroller taking it).
  const wentUp = first >= 0 && frames.slice(first).some((frame) => frame.st < start.st - 2);
  const conclusive = first >= 0 && wentUp && stillRunning && result.startDistanceFromEnd <= 4 && result.contentGrew > 0;
  const verdict = !conclusive ? "INCONCLUSIVE" : pulls === 0 && result.distanceFromEnd > 0 ? "PASS" : "FAIL";
  console.log(verdict);
  process.exitCode = verdict === "PASS" ? 0 : 1;
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
