import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

test("mobile shell builds static installable PWA assets", async () => {
  await execFileAsync(process.execPath, ["scripts/build-mobile-shell.mjs"], {
    cwd: repoRoot
  });

  const manifest = JSON.parse(await readFile(path.join(repoRoot, "dist/mobile/manifest.webmanifest"), "utf8"));
  const worker = await readFile(path.join(repoRoot, "dist/mobile/service-worker.js"), "utf8");
  const app = await readFile(path.join(repoRoot, "dist/mobile/mobile-app.js"), "utf8");
  // The database description both the page and the worker load. They each
  // carried their own copy of it and drifted far enough that the worker could
  // no longer open the database at all.
  const schema = await readFile(path.join(repoRoot, "dist/mobile/mobile-db.js"), "utf8");
  const icon = await stat(path.join(repoRoot, "dist/mobile/assets/accordagents-mark.png"));

  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, ".");
  assert.equal(manifest.background_color, "#eceef2");
  assert.equal(manifest.theme_color, "#eceef2");
  assert.equal(manifest.icons[0].src, "assets/accordagents-mark.png");
  assert.ok(icon.size > 0);
  for (const asset of ["./index.html", "./mobile-app.css?v=", "./mobile-app.js?v=", "./manifest.webmanifest"]) {
    assert.ok(worker.includes(asset), `service worker must precache ${asset}`);
  }
  assert.match(worker, /self\.addEventListener\("push"/);
  assert.match(worker, /accordagents-mobile-shell-v73/);
  assert.match(worker, /Open AccordAgents to sync updates\./);
  // W5 acceptance, static half (necessary but insufficient on its own — the
  // behavioral storage sweep lives in the browser harness):
  // 1. The push handler never reads the push payload; routing authority
  //    comes only from device storage.
  const pushHandler = /self\.addEventListener\("push",[\s\S]*?\n\}\);/.exec(worker)?.[0] ?? "";
  assert.ok(pushHandler, "service worker must have a push handler");
  assert.doesNotMatch(pushHandler, /event\.data/);
  // 2. What a push is about is read from the User's server only, signed
  //    with the phone's own key, through the bundled client. The worker
  //    holds no other way to read: no relay mailbox, no sealed envelopes.
  assert.match(worker, /backgroundServerSync/);
  assert.match(worker, /importScripts\("\.\/mobile-hub-client\.js"\)/);
  assert.match(worker, /"\/v1\/phone\/notices"/);
  assert.doesNotMatch(worker, /backgroundMailboxSync|acknowledgeStored|\/v1\/mailbox|sealedEnvelopes|SEALED_STORE|mailboxAccess/);
  assert.doesNotMatch(worker, /relaySealKeyBase64/);
  assert.doesNotMatch(worker, /AccordMailboxCrypto/);
  assert.doesNotMatch(worker, /openEnvelope\(|deriveAccess\(|crypto\.subtle/);
  assert.doesNotMatch(worker, /localStorage/);
  // The store the worker reads, named once, in the description both contexts
  // load. The worker imports it rather than repeating it, and asks only for
  // the store it reads.
  assert.match(worker, /importScripts\("\.\/mobile-db\.js"\)/);
  assert.match(worker, /SCHEMA\.openControlDb\(indexedDB, \[META_STORE\]\)/);
  assert.doesNotMatch(worker, /indexedDB\.open\(\s*DB_NAME\s*,/,
    "the worker must not pin a version of its own; that is what broke the push path");
  assert.match(worker, /accord-test-push/);
  // The relay's files are gone from the phone: nothing loads them, nothing
  // precaches them, and the build ships none of them.
  for (const removed of ["mobile-event-log.js", "mobile-machine-wake.js", "mobile-machine-sealing.js", "mobile-machine-command.js", "mobile-machine-channel.js"]) {
    assert.ok(!worker.includes(removed), `the service worker must not precache ${removed}`);
    assert.ok(!(await stat(path.join(repoRoot, "dist/mobile", removed)).catch(() => undefined)), `${removed} must not ship with the phone`);
  }
  const html = await readFile(path.join(repoRoot, "dist/mobile/index.html"), "utf8");
  const headers = await readFile(path.join(repoRoot, "dist/mobile/_headers"), "utf8");
  // Every script the page loads ships with the phone and is precached at the
  // shell's version, so an installed phone opened offline has all of them;
  // and nothing is precached that does not ship.
  const scripts = [...html.matchAll(/<script src="([^"?]+)\?v=([^"]+)"/g)].map((match) => ({ file: match[1], version: match[2] }));
  assert.ok(scripts.length >= 6, "the page loads its scripts");
  for (const script of scripts) {
    assert.ok((await stat(path.join(repoRoot, "dist/mobile", script.file))).size > 0, `${script.file} ships with the phone`);
    assert.ok(worker.includes(`./${script.file}?v=\${ASSET_VERSION}`), `the service worker must precache ${script.file} at the shell's version`);
  }
  for (const precached of [...worker.matchAll(/"\.\/([^"?`$]+\.(?:js|css|png|webmanifest))"/g)].map((match) => match[1])) {
    assert.ok((await stat(path.join(repoRoot, "dist/mobile", precached))).size > 0, `precached ${precached} ships with the phone`);
  }
  // The rules the phone shares with the desktop verbatim travel as one bundle
  // built from src/shared, loaded before the app, precached with it, and every
  // built-in avatar the desktop can show is copied under its catalog id.
  const shared = await readFile(path.join(repoRoot, "dist/mobile/mobile-shared.js"), "utf8");
  assert.match(shared, /AccordMobileShared/);
  assert.match(shared, /resolveChatParticipantAvatar/);
  assert.match(shared, /isChatMessageHiddenFromTimeline/);
  // The phone falls back to raw text when the bundle lacks this, which is the
  // defect it was added for: the fallback must never be reached silently.
  assert.match(shared, /stripChatControlBlocks/);
  assert.ok(html.indexOf('src="mobile-shared.js') < html.indexOf('src="mobile-app.js'), "the shared rules load before the app");
  assert.ok(worker.includes("./mobile-shared.js?v="), "service worker must precache the shared rules");
  // Activity's rules: without them an installed phone opened offline or on a
  // stale cache would show empty lists and a zero badge without any error.
  await readFile(path.join(repoRoot, "dist/mobile/mobile-activity.js"), "utf8");
  assert.ok(worker.includes("./mobile-activity.js?v=${ASSET_VERSION}"), "service worker must precache the Activity rules at the shell's version");
  assert.ok(html.indexOf('src="mobile-activity.js') > 0 &&
    html.indexOf('src="mobile-activity.js') < html.indexOf('src="mobile-app.js'), "the Activity rules load before the app");
  assert.doesNotMatch(app, /assets\/avatars\/(claude|codex)-(bunny|cat|dog|frog|hamster)\.png/, "the app names no avatar file itself; the catalog does");
  const { CHAT_AVATAR_CATALOG, chatAvatarAssetFileName } = await import(pathToFileURL(path.join(repoRoot, "dist/main/shared/chatAvatarCatalog.js")).href);
  for (const entry of CHAT_AVATAR_CATALOG) {
    const file = path.join(repoRoot, "dist/mobile/assets/avatars", chatAvatarAssetFileName(entry));
    assert.ok((await stat(file)).size > 0, `${entry.id} avatar is shipped with the phone`);
  }
  assert.ok(!(await stat(path.join(repoRoot, "dist/mobile/mobile-avatar-catalog.tmp.mjs")).catch(() => undefined)), "no build scratch file ships with the phone");
  assert.match(headers, /\/service-worker\.js\n\s+Cache-Control: public, max-age=0, must-revalidate/);
  assert.match(headers, /\/mobile-app\.js\n\s+Cache-Control: public, max-age=0, must-revalidate/);
  // W-E: the mobile origin holds the phone's signing key for the User's
  // server, so the policy that guards it is pinned here rather than trusted. The behavioural proof is the browser
  // harness, which serves the app under this exact policy; this pin is what
  // fails fast if a directive is weakened or dropped in a hurry.
  assert.match(headers, /^\/\*$/m, "the policy must apply to every path, not just the shell");
  const policy = /Content-Security-Policy:\s*(.+)/.exec(headers)?.[1] ?? "";
  assert.ok(policy, "the mobile origin must ship a Content-Security-Policy");
  for (const directive of [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'"
  ]) {
    assert.ok(policy.includes(directive), `policy must contain ${directive}: ${policy}`);
  }
  // The phone opens no WebSocket any more: every read and write is a signed
  // HTTPS request to the User's server, so https: is all connect-src allows.
  assert.ok(policy.includes("connect-src 'self' https:;"), `policy must allow https: connections: ${policy}`);
  assert.doesNotMatch(policy, /wss:|ws:/, `the policy must not allow WebSocket connections: ${policy}`);
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/, "no escape hatch may be added to the policy");
  assert.match(headers, /X-Content-Type-Options: nosniff/);
  assert.match(headers, /Referrer-Policy: no-referrer/);
  assert.match(headers, /Permissions-Policy: camera=\(self\)/);
  // The installed PWA must sit still. Without these the phone can drag the
  // whole app off the screen — iOS rubber-bands the root scroller in standalone
  // mode even with nothing to scroll, and pinch-zoom then lets it be panned
  // sideways. Both are honoured on the home screen but not in a Safari tab, so
  // nothing but this pin catches their removal.
  assert.match(html, /<meta name="viewport"[^>]*maximum-scale=1[^>]*user-scalable=no/);
  assert.match(html, /<meta name="viewport"[^>]*viewport-fit=cover/);
  const assetVersion = /const ASSET_VERSION = "([^"]+)"/.exec(worker)?.[1];
  assert.ok(assetVersion, "service worker must declare an asset version");
  const htmlAssetVersions = [...html.matchAll(/(?:mobile-app\.css|mobile-db\.js|jsqr\.js|mobile-hub-client\.js|mobile-shared\.js|mobile-activity\.js|mobile-app\.js)\?v=([^"']+)/g)]
    .map((match) => match[1]);
  assert.deepEqual(htmlAssetVersions, [assetVersion, assetVersion, assetVersion, assetVersion, assetVersion, assetVersion, assetVersion]);
  assert.match(html, /data-screen-label="Mobile control"/);
  assert.match(html, /id="chats-screen"/);
  assert.match(html, />Chats</);
  assert.match(html, /id="chat-list"/);
  assert.match(html, /id="timeline-screen"/);
  assert.match(html, /mobile-status-bar/);
  assert.doesNotMatch(html, /aria-label="Participants"/);
  assert.match(html, /mobile-header-spacer/);
  // The composer pill must not be a <label> around the textarea: a tap landing
  // on the label rather than the field focuses it by label activation, which on
  // iOS shows a caret and the accessory bar but never raises the keyboard.
  assert.match(html, /<div class="composer-input-wrap">/);
  assert.doesNotMatch(html, /<label class="composer-input-wrap"/);
  assert.match(html, /<textarea id="composer-input"[^>]*aria-label="Message the room"/);
  const mentionButtonMarkup = /<button\b[^>]*\bid="mention-button"[^>]*>/.exec(html)?.[0] ?? "";
  assert.ok(mentionButtonMarkup, "the composer must render a mention button");
  assert.match(mentionButtonMarkup, /\btype="button"/);
  assert.match(mentionButtonMarkup, /\baria-label="Mention a member"/);
  assert.match(mentionButtonMarkup, /\baria-controls="mention-menu"/);
  assert.doesNotMatch(mentionButtonMarkup, /\baria-expanded=/);
  assert.doesNotMatch(mentionButtonMarkup, /\baria-haspopup=/);
  assert.doesNotMatch(html, /<span aria-hidden="true">@<\/span>/);
  // W-M: the live reply opens in its own view, and only a row that can actually
  // be followed advertises itself as openable.
  assert.match(html, /id="stream-view"/);
  assert.match(html, /id="stream-body"/);
  assert.match(app, /function applyStreamableState/);
  // Live text comes from the User's server's progress, read while a member
  // runs; the phone holds no socket of its own.
  assert.match(app, /"\/v1\/phone\/progress"/);
  assert.doesNotMatch(app, /WebSocket/);
  // A terminal that predates a pending row cannot be that row's ending. This
  // guard is what stops an upstream mislabelling from deleting a live row.
  assert.match(app, /entry\.status === "Running" && entry\.runId/);
  // A phone-started turn's answer runs under a fan-out run id the phone has
  // never seen, so requiring BOTH the run id and the mobile event id to match
  // meant the placeholder never cleared: the answer landed and "Thinking"
  // stayed above it forever. Either key may clear a row, but the mobile event
  // id — which every participant on one phone message shares — clears only
  // placeholder scaffolding, or the first agent to finish would delete a
  // second agent's live row.
  assert.match(app, /const matchesMessage = Boolean\(messageId\) &&/);
  assert.match(app, /const matchesScaffolding = isPlaceholderTimelineContent\(entry\.content\) &&/);
  // A finished message ends its own row, not every pending row of its run: a
  // turn that posts an intermediate note mid-run must keep writing afterwards.
  assert.doesNotMatch(app, /const matchesRun = Boolean\(runId\) && entry\.runId === runId;/);
  assert.doesNotMatch(app, /\(mobileEventId \? entry\.mobileEventId === mobileEventId : true\)/);
  // Stale rows are swept by node identity. Sweeping by "is this key still
  // wanted" kept every node sharing a wanted key, so two nodes under one key
  // left an orphan on screen forever — an answer or a "Thinking" the store no
  // longer had.
  // The in-progress row is published before routing has picked anyone, so a
  // mentionless send has no one to name. Showing "Agent" with a letter avatar
  // invented a member and then swapped identity mid-run.
  assert.match(app, /identified: Boolean\(entry\.participantLabel\)/);
  assert.match(app, /function applyRowIdentity/);
  assert.match(app, /return entry\.identified === false \? "" : \(entry\.participantLabel \|\| "Agent"\)/);
  assert.doesNotMatch(app, /handle\.textContent = participantLabel;/);
  assert.match(
    await readFile(path.join(repoRoot, "dist/mobile/mobile-app.css"), "utf8"),
    /\.message-avatar\[data-identified="0"\]/
  );
  // Scaffolding is not a message and must not dress as one: no avatar slot, no
  // handle, no status, no running clock — those belong to a real member. It
  // shows a small pulsing indication where the answer will appear, and it
  // respects reduced motion.
  assert.match(app, /scaffolding: isScaffoldingEntry\(entry\)/);
  assert.match(app, /function renderScaffoldingInto/);
  assert.match(app, /dots\.className = "message-typing"/);
  assert.match(app, /aria-label", "Waiting for a reply"/);
  const css = await readFile(path.join(repoRoot, "dist/mobile/mobile-app.css"), "utf8");
  // Read one selector's own declaration block. Matching across blocks with a
  // lazy [\s\S]*? would let a declaration from a LATER rule satisfy an
  // assertion about this one, so these pins would survive the deletion they
  // exist to catch.
  const cssBlock = (selector) => {
    const open = css.indexOf(`${selector} {`);
    assert.ok(open >= 0, `${selector} must exist in the stylesheet`);
    const close = css.indexOf("}", open);
    assert.ok(close > open, `${selector} must have a closing brace`);
    return css.slice(open, close);
  };
  // The phone rules must key off the installed app too, not width alone: a
  // phone held sideways is wider than the breakpoint, and the width-only form
  // brought the desktop preview frame and the rubber-band back on rotation.
  const phoneQuery = "@media (max-width: 620px), (display-mode: standalone) {";
  assert.equal(css.split(phoneQuery).length - 1, 2, "both phone blocks must key off width OR standalone");
  const lock = cssBlock("  html,\n  body");
  // The height must be measured, not inherited: iOS hands the shell a stale,
  // too-tall height at first paint, which puts the composer half off the
  // bottom of a page that can no longer be scrolled.
  assert.match(lock, /height: var\(--app-h, 100%\)/);
  assert.match(app, /function trackUsableHeight\(\)/);
  // A picture with no caption used to vanish on both sides, and the timeline
  // carries metadata only, so the bytes are asked of the server by id once.
  assert.match(app, /function timelineAttachmentsFromEvent\(event\)/);
  assert.match(app, /if \(!content && attachments\.length === 0\)/);
  assert.match(app, /"\/v1\/phone\/attachment"/);
  assert.match(app, /function rememberAttachmentResult\(attachmentId, result\)/);
  assert.match(css, /\.message-image \{/);
  // A replaced element renders no pseudo-element, so the failure reason has to
  // live in its own node or the reader is shown an empty box.
  assert.match(css, /\.message-image-note \{/);
  assert.doesNotMatch(css, /\.message-image\[data-state="[a-z-]+"\]::after/);
  assert.match(app, /function applyAttachmentResult\(image, result\)/);
  assert.match(app, /ATTACHMENT_CACHE_MAX_ENTRIES/);
  assert.match(app, /MOBILE_UPLOAD_MAX_TOTAL_BYTES/);
  // Sending a picture from the phone: the limits are enforced where the picture
  // is chosen, and a picture with no caption is a message on its own.
  assert.match(html, /id="composer-image-input"[^>]*accept="image\/png,image\/jpeg,image\/webp"/);
  // Slack's shape: the controls live on a row inside the input box, with send at
  // the far end of that row — not icons floating beside the box.
  assert.match(html, /<div class="composer-toolbar">[\s\S]*id="attach-button"[\s\S]*id="mention-button"[\s\S]*id="send-button"[\s\S]*<\/div>/);
  assert.match(css, /\.composer-toolbar \{/);
  assert.doesNotMatch(css, /composer-attach-button|composer-mention-button/);
  // Models read no image metadata, so orientation has to be in the pixels.
  assert.match(app, /imageOrientation: "from-image"/);
  assert.match(app, /MOBILE_UPLOAD_MAX_EDGE = 2576/);
  // A phone whose WebKit cannot do that must still be able to send a picture.
  assert.match(app, /function decodeOrientedImage\(file\)/);
  // Every control in the composer row must keep the field focused on tap.
  // Without it the first tap only puts the iOS keyboard away and the button
  // appears to do nothing.
  assert.match(app, /function keepFieldFocusedOnTap\(element\)/);
  // The stored entry and the rendered row are different shapes; the picture was
  // stored and then dropped on the way to the row.
  assert.match(app, /attachments: entry\.attachments,/);
  assert.match(app, /keepFieldFocusedOnTap\(attachButton\)/);
  assert.match(app, /keepFieldFocusedOnTap\(document\.getElementById\("send-button"\)\)/);
  // JPEG has no transparency, so a PNG or WebP must not silently become one.
  assert.match(app, /sourceMimeType === "image\/jpeg" \? "image\/jpeg" : "image\/png"/);
  assert.match(app, /if \(\(!content && pendingAttachments\.length === 0\) \|\| !conversationId\)/);
  assert.match(app, /MOBILE_UPLOAD_MAX_BYTES = 4 \* 1024 \* 1024/);
  assert.match(css, /\.composer-attachment-thumb \{/);
  assert.match(app, /setProperty\("--app-h"/);
  // The keyboard must not resize the app. Tracking every frame of the iOS
  // keyboard animation made the screen jump the moment the input was tapped.
  assert.match(app, /function composerHasFocus\(\)/);
  assert.match(app, /if \(composerHasFocus\(\) && width === lastWidth\) \{\n\s*return;/);
  assert.doesNotMatch(app, /viewport\.addEventListener\("resize"/);
  assert.doesNotMatch(app, /viewport\.addEventListener\("scroll"/);
  // One sample can land mid-animation and stick, with nothing to correct it.
  assert.match(app, /\[150, 350, 600, 900\]\.forEach/);
  for (const event of ["resize", "orientationchange", "pageshow"]) {
    assert.match(app, new RegExp(`window\\.addEventListener\\("${event}", remeasure\\)`));
  }
  // Focus leaving a field still re-measures, once the tap that moved it has
  // landed: measured mid-tap, the layout moved under the finger.
  assert.match(app, /document\.addEventListener\("focusout", function \(\) \{\n\s*afterTapLands\(remeasure\);/);
  assert.match(app, /visibilitychange/);
  // A height change that drops the reader out of the latest message would be a
  // silent regression: rotating would scroll them up into history.
  assert.match(app, /const wasAtLatest = isNearBottom\(threadSurface\(\)\)/);
  assert.match(app, /if \(wasAtLatest\) \{\n\s*scrollToLatestWhenSettled/);
  assert.match(app, /height === lastHeight/);
  assert.match(app, /trackUsableHeight\(\);\n\s*init\(\)/);
  assert.match(lock, /overflow: hidden/);
  assert.match(lock, /overscroll-behavior: none/);
  assert.match(cssBlock(".mscroll"), /overscroll-behavior: contain/);
  assert.doesNotMatch(css, /width:\s*100vw/, "100vw can exceed the layout viewport on iOS and lets the app pan sideways");
  // The app is full-bleed on a phone, so anything touching an edge must clear
  // the status bar and the home indicator. Dropping these puts the composer
  // under the indicator, which is what happened the moment the shell first
  // filled the whole screen.
  assert.match(cssBlock(".composer"), /padding: 10px 16px calc\(14px \+ env\(safe-area-inset-bottom\)\)/);
  // The pill is two rows now — field on top, controls beneath — so it has no
  // fixed height; what must hold is that the field owns the full width and
  // nothing is layered over it, which is what broke the keyboard before.
  assert.match(cssBlock(".composer-input-wrap"), /flex-direction: column/);
  assert.match(cssBlock(".composer textarea"), /width: 100%/);
  assert.doesNotMatch(cssBlock(".composer textarea"), /position: absolute/);
  assert.match(cssBlock(".composer .composer-tool"), /width: 44px/);
  assert.match(cssBlock(".composer .composer-send"), /width: 44px/);
  // The press tint is a named surface now so the dark palette can restate it;
  // its light value is still the handoff's.
  assert.match(cssBlock(".composer .composer-tool:active"), /background: var\(--press\)/);
  assert.match(cssBlock(":root"), /--press: rgba\(22, 25, 31, 0\.08\)/);
  assert.match(cssBlock(".composer .composer-send"), /margin-left: auto/);
  assert.match(cssBlock(".mobile-chat-header"), /padding: calc\(2px \+ env\(safe-area-inset-top\)\)/);
  assert.match(cssBlock(".mobile-chats-header"), /padding: calc\(6px \+ env\(safe-area-inset-top\)\)/);
  assert.match(cssBlock(".mobile-chat-list"), /padding-bottom: calc\(18px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(cssBlock(".jump-to-latest"), /bottom: calc\(78px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(cssBlock(".stream-view-head"), /padding: calc\(8px \+ env\(safe-area-inset-top\)\)/);
  assert.match(cssBlock(".stream-view-body"), /padding: 14px 16px calc\(24px \+ env\(safe-area-inset-bottom\)\)/);
  // The mock status bar and home indicator must lose to the phone query, which
  // means their display:none has to come after the rules that set display:flex.
  // Written the other way round it silently ships 76px of scenery to the phone.
  const statusBarRule = css.indexOf(".mobile-status-bar {");
  assert.ok(statusBarRule > 0, "the mock status bar rule must exist");
  const hideChrome = css.indexOf(phoneQuery, statusBarRule);
  assert.ok(hideChrome > statusBarRule, "the mock chrome must be hidden after it is defined");
  assert.match(css.slice(hideChrome, hideChrome + 200), /\.mobile-status-bar,\n\s*\.mobile-home-indicator \{\n\s*display: none;/);
  assert.match(css, /\.message-typing span \{/);
  assert.match(css, /@keyframes typing-pulse/);
  assert.match(
    css.slice(css.indexOf("@media (prefers-reduced-motion: reduce) {", css.indexOf(".message-typing"))),
    /\.message-typing span \{\s*animation: none;/
  );
  // Whoever is at the end is following: arriving rows come into sight instead
  // of landing below the fold. Whoever left the end is reading history and is
  // never yanked back — the pill offers the way back instead. The measurement
  // must happen BEFORE the rows are mounted, or appending content is itself
  // what makes the answer "not at the bottom" and the view follows nothing.
  assert.match(app, /const wasAtBottom = isNearBottom\(threadSurface\(\)\);\s*reconcileMessageRows\(list, rows, rowSignatures\);/);
  assert.match(app, /if \(wasAtBottom\) \{\s*scrollToLatestWhenSettled\("auto"\);/);
  // A run that dies produces no terminal of its own: the control service's
  // catch writes one under the INGEST run's name, which matches no member's
  // row. Scoped to that name on purpose — one member erroring while another
  // writes carries the same mobile event id and must not clear the other.
  assert.match(app, /function isPhoneMessageFailure/);
  assert.match(app, /status === "error" && Boolean\(mobileEventId\) && runId === "mobile-" \+ mobileEventId/);
  // One writer for the timeline store, so the scaffolding rule cannot be
  // bypassed: the direct put helper is gone.
  assert.doesNotMatch(app, /function putTimelineEntry\(/);
  assert.match(app, /function dedupeRenderRowsByKey/);
  assert.match(app, /if \(!kept\.has\(child\) && child\.id !== "control-cards"\) \{/);
  assert.doesNotMatch(app, /if \(!nextKeys\.has\(child\.dataset\.rowKey\)\)/);
  assert.match(await readFile(path.join(repoRoot, "dist/mobile/mobile-app.css"), "utf8"), /width: 390px;/);
  assert.match(await readFile(path.join(repoRoot, "dist/mobile/mobile-app.css"), "utf8"), /height: 844px;/);
  assert.match(await readFile(path.join(repoRoot, "dist/mobile/mobile-app.css"), "utf8"), /border-radius: 44px;/);
  // The stage color is a named surface now (the dark palette restates it);
  // its light value is still the handoff's.
  assert.match(await readFile(path.join(repoRoot, "dist/mobile/mobile-app.css"), "utf8"), /--stage: #eceef2;/);
  assert.match(await readFile(path.join(repoRoot, "dist/mobile/mobile-app.css"), "utf8"), /background: var\(--stage\);/);
  assert.match(await readFile(path.join(repoRoot, "dist/mobile/mobile-app.css"), "utf8"), /border-radius: 18px 18px 6px 18px;/);
  // The page opens through the same shared description the worker imports,
  // rather than a version constant of its own.
  assert.match(app, /schema\.openControlDb\(indexedDB\)/);
  assert.match(schema, /DB_VERSION = \d+/);
  // Everything the phone owes goes to the User's server and nowhere else: an
  // entry is "Sent" only when the server answered its operation accepted (or
  // a repeat of one it took); refused, it says the server's reason.
  assert.match(app, /return await flushOutboxToServer\(entries\)/);
  assert.match(app, /result\.status === "accepted" \|\| result\.status === "duplicate"/);
  assert.match(app, /result\.status === "rejected"/);
  // Every failed try is written to the send log, kept bounded (agreement Д12).
  assert.match(app, /const SEND_FAILURES_STORE = "sendFailures"/);
  assert.match(schema, /sendFailures: "sendFailures"/);
  // Phase 5: the relay is gone from the phone. No mailbox, no sealing, no
  // socket, no machine of its own to command or wake; a pairing made the old
  // way is cleared and the phone says, once, that it has to pair again.
  for (const gone of [/\/v1\/mailbox/, /relaySealKey(?!")/, /sealRelayPayload|openRelayPayload|AccordMailboxCrypto/, /flushOutboxViaMailbox|flushOutboxViaRelay|pollMailboxTimeline/,
    /AccordMachineCommand|AccordMachineChannel|AccordMobileEventLog|AccordMobileMachineWake|AccordMachineSealing/, /sendRelayPayload|getRelaySocket/]) {
    assert.doesNotMatch(app, gone, `the phone must not keep ${gone}`);
  }
  assert.match(app, /OLD_PAIRING_KEY = "accordagents\.mobile\.pairing\.v1"/);
  assert.match(app, /localStorage\.removeItem\(OLD_PAIRING_KEY\)/);
  assert.match(app, /"This phone was paired the old way\. Pair it again from Settings on your Mac\."/);
  // W-N: only a participant's finished message may end a run. The behavioral
  // proof is scripts/mobile-inprogress-row.test.mjs; this pin fails fast if the
  // role guard is dropped, since without it the user's own message comes back
  // in a snapshot as "done" carrying the run's identity and deletes the
  // in-progress row.
  assert.match(app, /status !== "pending" && role === "participant" && \(runId \|\| mobileEventId \|\| messageId\)/);
  // W-K: a refused push endpoint must be recorded and stated, never swallowed.
  // The behavioral proof is scripts/mobile-push-unavailable.test.mjs.
  assert.match(app, /pushEndpointRejected = true/);
  assert.match(app, /alertsState = "unavailable"/);
  // Everything the phone writes is one operation of the User's server, sent
  // in a signed request by the bundled client (agreements Д1, Д10): no record
  // of its own is signed, and nothing of the old chains is left.
  assert.match(app, /client\.postOps\(/);
  assert.match(app, /kind: "message\.create"/);
  assert.match(app, /kind: "turn\.stop"/);
  assert.match(app, /kind: "card\.answer"/);
  assert.doesNotMatch(app, /mintHubEvent|pushEvents|hubLogicalTs|rechainFrom|repairHubGaps/);
  // A message is faded until the server took it and then says nothing; only
  // a refusal says why (the User, 2026-10-29).
  assert.doesNotMatch(app, /"Not sent, retrying"|"Taken to work"/);
  assert.match(app, /"Not taken by your server"/);
  assert.match(app, /sha256Hex/);
  assert.match(app, /mobile\.timeline\.events/);
  assert.match(app, /stopRunFromPhone/);
  assert.match(app, /"\/v1\/phone\/chats"/);
  assert.match(app, /"\/v1\/phone\/timeline"/);
  assert.match(app, /"\/v1\/phone\/changes"/);
  assert.match(app, /TIMELINE_STORE/);
  // The pairing code the desktop shows, from the link's fragment only.
  assert.match(app, /fragment\.get\("hub"\)/);
  assert.match(app, /fragment\.get\("t"\)/);
  assert.match(app, /handleRelayTimelinePayload/);
  assert.match(app, /activeFlushOutboxPromise/);
  assert.match(app, /Tunnel reconnecting/);
  // The author travels with the text: the control-block rule applies to a
  // member's message and never to the User's own words.
  assert.match(app, /renderMessageContentIfChanged\(content, entry\.content, entry\.author\)/);
  assert.match(app, /appendInlineMarkdown/);
  assert.doesNotMatch(app, /content\.textContent = entry\.content/);
  assert.match(app, /putTimelineEntryDeduped/);
  assert.match(app, /timelineEntryDedupeKey/);
  assert.match(app, /dedupeTimelineEntries/);
  assert.match(app, /reconcileMessageRows\(list, rows, rowSignatures\)/);
  assert.match(app, /timelineRenderRowKey/);
  assert.match(app, /updateMessageRow\(item, entry\)/);
  assert.match(app, /renderMessageContentIfChanged/);
  assert.doesNotMatch(app, /list\.textContent = ""/);
  // Coming back from the background, what this phone owes goes first, then
  // the chats and the open chat are read again and the feed of changes is
  // followed again.
  assert.match(app, /await retryOutboxNow\(\)\.catch\(function \(\) \{ return undefined; \}\);\n\s*await requestChatListViaRelay\(pairing\)[\s\S]{0,240}startServerChanges\(\);/);
  // Opening the app: what it owes goes out, then the chats come in.
  assert.match(app, /async function initHubSession\(pairing\) \{[\s\S]+const flushResult = await retryOutboxNow\(\)[\s\S]+await requestChatListViaRelay\(pairing\);/);
  // Opening a chat, from the list or from Activity, goes through one helper.
  assert.match(app, /function openConversation\(conversationId, options\)[\s\S]+requestTimelineViaRelay\(pairing, conversationId\)/);
  assert.match(app, /row\.addEventListener\("click", function \(\) \{\s*(void )?openConversation\(chat\.id\)/);
  assert.match(app, /globalThis\.AccordAgentsMobile/);
});

test("mobile shell matches desktop member mention filtering and insertion", async () => {
  await execFileAsync(process.execPath, ["scripts/build-mobile-shell.mjs"], {
    cwd: repoRoot
  });
  await import(pathToFileURL(path.join(repoRoot, "dist/mobile/mobile-app.js")).toString());
  const mobile = globalThis.AccordAgentsMobile;
  const members = [{
    id: "participant-taylor",
    handle: "taylor-claude-engineer",
    mentionHandle: "taylor-claude-engineer",
    displayName: "@taylor-claude-engineer",
    roleLabel: "Software Engineer"
  }, {
    id: "participant-assistant",
    handle: "admin",
    mentionHandle: "assistant",
    displayName: "Chat Assistant",
    roleLabel: "Administrator"
  }];

  assert.equal(mobile.activeMentionQuery("Ask @tay"), "tay");
  assert.equal(mobile.activeMentionQuery("email@example.com"), undefined);
  assert.deepEqual(mobile.mentionOptions("Ask @tay", members), [members[0]]);
  assert.deepEqual(mobile.mentionOptions("Ask @chat", members), [members[1]]);
  assert.equal(mobile.replaceActiveMention("Ask @tay", members[0].mentionHandle), "Ask @taylor-claude-engineer ");
  assert.equal(mobile.replaceActiveMention("@adm", members[1].mentionHandle), "@assistant ");

  assert.deepEqual(mobile.mentionShortcutEdit("", 0, 0), { value: "@", caret: 1 });
  assert.deepEqual(
    mobile.mentionShortcutEdit("Draft text", 5, 5),
    { value: "Draft @ text", caret: 7 }
  );
  assert.deepEqual(
    mobile.mentionShortcutEdit("Draft text", 6, 10),
    { value: "Draft @", caret: 7 },
    "the shortcut follows editor convention by replacing selected text"
  );
  assert.deepEqual(
    mobile.replaceMentionAtCaret("Draft @ text", members[0].mentionHandle, 7),
    { value: "Draft @taylor-claude-engineer text", caret: 30 }
  );
});

test("mobile Stop is offered only for a real participant run", async () => {
  await execFileAsync(process.execPath, ["scripts/build-mobile-shell.mjs"], {
    cwd: repoRoot
  });
  await import(pathToFileURL(path.join(repoRoot, "dist/mobile/mobile-app.js")).toString());
  const mobile = globalThis.AccordAgentsMobile;

  assert.equal(mobile.isCancellableMobileRow({
    author: "agent",
    status: "Running",
    runId: "mobile-ingest-placeholder",
    cancellable: false
  }), false);
  assert.equal(mobile.isCancellableMobileRow({
    author: "agent",
    status: "Running",
    runId: "participant-run",
    cancellable: true
  }), true);
});

test("mobile shell collapses duplicate terminal timeline entries by run identity", async () => {
  await execFileAsync(process.execPath, ["scripts/build-mobile-shell.mjs"], {
    cwd: repoRoot
  });
  await import(pathToFileURL(path.join(repoRoot, "dist/mobile/mobile-app.js")).toString());
  const mobile = globalThis.AccordAgentsMobile;
  const rows = mobile.dedupeTimelineEntries([
    {
      id: "conversation:progress-message",
      role: "participant",
      participantLabel: "@drew-codex-engineer",
      content: "same terminal result",
      status: "done",
      createdAt: "2026-08-13T00:00:00.000Z",
      runId: "mobile-event-1"
    },
    {
      id: "conversation:snapshot-message",
      role: "participant",
      participantLabel: "@drew-codex-engineer",
      content: "same terminal result",
      status: "done",
      createdAt: "2026-08-13T00:00:01.000Z",
      runId: "mobile-event-1"
    }
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "conversation:snapshot-message");
});

test("mobile shell collapses duplicate terminal timeline entries by mobile event identity", async () => {
  await execFileAsync(process.execPath, ["scripts/build-mobile-shell.mjs"], {
    cwd: repoRoot
  });
  await import(pathToFileURL(path.join(repoRoot, "dist/mobile/mobile-app.js")).toString());
  const mobile = globalThis.AccordAgentsMobile;
  const rows = mobile.dedupeTimelineEntries([
    {
      id: "conversation:cloud-worker-message",
      conversationId: "conversation-1",
      role: "participant",
      participantLabel: "@drew-codex-engineer",
      content: "same visible cloud result",
      status: "done",
      createdAt: "2026-08-13T00:00:00.000Z",
      runId: "mobile-event-1",
      messageId: "cloud-worker-message",
      mobileEventId: "event-1"
    },
    {
      id: "conversation:desktop-snapshot-message",
      conversationId: "conversation-1",
      role: "participant",
      participantLabel: "@drew-codex-engineer",
      content: "same visible cloud result",
      status: "done",
      createdAt: "2026-08-13T00:00:01.000Z",
      runId: "desktop-replay-event-1",
      messageId: "desktop-snapshot-message",
      mobileEventId: "event-1"
    }
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "conversation:desktop-snapshot-message");
});

test("mobile shell gives scaffolding one row and every real message its own", async () => {
  await execFileAsync(process.execPath, ["scripts/build-mobile-shell.mjs"], {
    cwd: repoRoot
  });
  await import(pathToFileURL(path.join(repoRoot, "dist/mobile/mobile-app.js")).toString());
  const mobile = globalThis.AccordAgentsMobile;
  const pending = {
    id: "conversation:pending",
    conversationId: "conversation-1",
    role: "participant",
    participantLabel: "@codex",
    content: "@codex is running...",
    status: "pending",
    runId: "mobile-run-1",
    mobileEventId: "mobile-event-1"
  };
  const terminal = {
    id: "conversation:done",
    conversationId: "conversation-1",
    role: "participant",
    participantLabel: "@codex",
    content: "final result",
    status: "done",
    runId: "mobile-run-1",
    mobileEventId: "mobile-event-1",
    messageId: "conversation:done",
    sourceId: "conversation:done"
  };
  // These used to share a row key so the placeholder could BECOME the answer in
  // one stable DOM node. That contract cannot survive a turn that posts more
  // than one message: keyed by the phone message, an intermediate note and the
  // still-live answer collapsed into one row, so the note ate the live row and
  // the turn looked finished while it was still writing. Scaffolding is now
  // retired when a real row arrives — in the same write transaction, so the two
  // cannot both be on screen — and every real message keeps its own row.
  assert.notEqual(mobile.timelineRenderRowKey(pending), mobile.timelineRenderRowKey(terminal));
  assert.match(mobile.timelineRenderRowKey(pending), /^timeline-mobile\0conversation-1\0mobile-event-1\0@codex$/);
  assert.match(mobile.timelineRenderRowKey(terminal), /^timeline-message\0conversation-1\0conversation:done\0@codex$/);
  // Two real messages from one run are two rows, not one.
  const interim = { ...terminal, id: "conversation:interim", messageId: "conversation:interim", sourceId: "conversation:interim", content: "an interim note" };
  assert.notEqual(mobile.timelineRenderRowKey(interim), mobile.timelineRenderRowKey(terminal));
  // Replayed scaffolding for the same phone message stays one row.
  assert.equal(
    mobile.timelineRenderRowKey({ ...pending, id: "conversation:pending-again" }),
    mobile.timelineRenderRowKey(pending)
  );
});
