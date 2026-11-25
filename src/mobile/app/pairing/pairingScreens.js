import { render } from "../chat/render.js";
import { isSameServer, loadHubPairing, pairWithServer, serverHost, serverPairing } from "./hubPairing.js";
import { readBootstrapFromLocation } from "./pairing.js";

/**
 * The question a pairing code asks before it is used, with the server's
 * address; and, while a pairing would replace this phone's, how it goes
 * (the chats stay until it is done, and stay as they are when it fails).
 */
export function renderPairingPrompt(pairingState) {
  const container = document.getElementById("chat-list");
  if (!container) return;
  const tag = "hub-prompt:" + pairingState.status + ":" + (pairingState.invite ? pairingState.invite.hubUrl : "") + ":" + (pairingState.message || "");
  if (container.dataset.state === tag) return;
  container.dataset.state = tag;
  container.textContent = "";
  const notice = document.createElement("div");
  notice.className = "mobile-empty pairing-confirm";
  const actions = document.createElement("div");
  actions.className = "pairing-form";
  const button = function (className, label, onClick) {
    const element = document.createElement("button");
    element.type = "button";
    element.className = className;
    element.textContent = label;
    element.addEventListener("click", onClick);
    return element;
  };
  const host = function (value) {
    const strong = document.createElement("strong");
    strong.className = "pairing-host";
    strong.textContent = serverHost(value);
    return strong;
  };
  const dismiss = function () {
    serverPairing.hubPairingState = undefined;
    delete container.dataset.state;
    void render();
  };
  if (pairingState.status !== "confirm") {
    notice.textContent = pairingState.status === "pairing" ? "Pairing with your server…" : (pairingState.message || "This phone could not pair.");
    container.append(notice);
    if (pairingState.status !== "pairing") {
      actions.append(button("pairing-cancel", "Back to chats", dismiss));
      container.append(actions);
    }
    return;
  }
  const invite = pairingState.invite;
  const current = loadHubPairing();
  const confirm = function () {
    // One tap pairs once: a second would spend the same code again.
    if (serverPairing.hubPairingState && serverPairing.hubPairingState.status !== "confirm") return;
    for (const item of actions.querySelectorAll("button")) item.disabled = true;
    serverPairing.hubPairingState = { status: "pairing", replacing: Boolean(current) };
    void pairWithServer(invite);
  };
  if (!current) {
    notice.append("Pair this phone with the server at ", host(invite.hubUrl), "? Continue only if you made this code on your computer just now.");
    actions.append(button("pairing-submit", "Pair", confirm), button("pairing-cancel", "Cancel", dismiss));
  } else if (isSameServer(current, invite)) {
    notice.append("Pair this phone again with your server at ", host(invite.hubUrl), "? Its chats stay as they are.");
    actions.append(button("pairing-submit", "Pair again", confirm), button("pairing-cancel", "Cancel", dismiss));
  } else {
    notice.append("This phone is paired with your server at ", host(current.hubUrl), ". Pair it with the server at ", host(invite.hubUrl),
      " instead? The chats on this phone and anything not sent yet are cleared, and it uses only the new server from then on.");
    actions.append(button("pairing-submit", "Replace pairing", confirm), button("pairing-cancel", "Keep current pairing", dismiss));
  }
  container.append(notice, actions);
}

// An installed home-screen app gets its own storage on iOS, so it starts with
// no pairing even though Safari has one. Say that plainly instead of showing
// an empty list with dead buttons. The same screen serves re-pairing after a
// revoke: the QR scan and paste box are the no-hand-copy path to a new link.
export function renderUnpairedNotice(noticeText, stateTag) {
  const state = stateTag || "unpaired";
  const container = document.getElementById("chat-list");
  if (!container || container.dataset.state === state) {
    return;
  }
  container.dataset.state = state;
  container.textContent = "";

  const notice = document.createElement("div");
  notice.className = "mobile-empty";
  notice.textContent = noticeText ||
    ("Paste the pairing link from the desktop app to connect this device. " +
    "An installed app has its own storage, so it pairs separately from the browser.");

  const form = document.createElement("form");
  form.className = "pairing-form";
  const input = document.createElement("input");
  input.type = "url";
  input.className = "pairing-input";
  input.placeholder = "https://mobile.accordagents.com/?pair=server#hub=…";
  input.autocomplete = "off";
  input.autocapitalize = "off";
  input.spellcheck = false;
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "pairing-submit";
  submit.textContent = "Pair this device";
  const error = document.createElement("p");
  error.className = "pairing-error";

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    const value = input.value.trim();
    if (!value) {
      return;
    }
    try {
      // Same parser the app uses when opened via the link, so a pasted link
      // and a tapped link produce exactly the same pairing.
      const pairing = readBootstrapFromLocation({ href: value });
      if (!pairing) {
        throw new Error("That link does not contain pairing details.");
      }
      delete container.dataset.state;
      void render();
    } catch (parseError) {
      error.textContent = parseError instanceof Error
        ? parseError.message
        : "That link could not be read. Copy it again from the desktop app.";
    }
  });

  const scan = document.createElement("button");
  scan.type = "button";
  scan.className = "pairing-scan";
  scan.textContent = "Scan QR code";
  const scanner = document.createElement("div");
  scanner.className = "pairing-scanner";
  const video = document.createElement("video");
  video.setAttribute("playsinline", "");
  video.muted = true;
  scanner.append(video);

  scan.addEventListener("click", function () {
    void startPairingScan(video, scanner, error, function (decoded) {
      input.value = decoded;
      form.dispatchEvent(new Event("submit", { cancelable: true }));
    });
  });

  form.append(input, submit);
  container.append(notice, scan, scanner, form, error);
}

// Scanning happens inside the app because iOS opens a camera-scanned link in
// Safari, which cannot reach an installed home-screen app's storage.
async function startPairingScan(video, scanner, error, onDecoded) {
  if (typeof jsQR !== "function") {
    error.textContent = "The QR reader did not load. Paste the link instead.";
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" }
    });
  } catch {
    error.textContent = "Camera access was refused. Paste the link instead.";
    return;
  }
  error.textContent = "";
  scanner.classList.add("is-active");
  video.srcObject = stream;
  await video.play().catch(function () {
    return undefined;
  });
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const stop = function () {
    scanner.classList.remove("is-active");
    for (const track of stream.getTracks()) {
      track.stop();
    }
  };
  const deadline = Date.now() + 60_000;
  const tick = function () {
    if (!scanner.classList.contains("is-active")) {
      return;
    }
    if (Date.now() > deadline) {
      stop();
      error.textContent = "No code found. Try again, or paste the link.";
      return;
    }
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const frame = context.getImageData(0, 0, canvas.width, canvas.height);
      const found = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: "dontInvert" });
      if (found && found.data) {
        stop();
        onDecoded(found.data);
        return;
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
