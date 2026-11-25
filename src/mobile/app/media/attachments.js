import { keepingReaderAtLatest } from "../chat/chatScroll.js";
import { applyDock } from "../shell/home.js";
import { hubPhoneGet } from "../sync/serverReads.js";

export function timelineAttachmentsFromEvent(event) {
  if (!event || !Array.isArray(event.attachments)) {
    return [];
  }
  return event.attachments
    .filter(function (attachment) {
      return attachment && typeof attachment.id === "string" && attachment.id.trim();
    })
    .map(function (attachment) {
      return {
        id: attachment.id,
        filename: typeof attachment.filename === "string" ? attachment.filename : "image",
        mimeType: typeof attachment.mimeType === "string" ? attachment.mimeType : "image/png",
        width: Number.isFinite(attachment.width) ? attachment.width : undefined,
        height: Number.isFinite(attachment.height) ? attachment.height : undefined
      };
    });
}

// Bytes arrive once per image and stay for the session. The timeline is read
// again constantly; refetching a screenshot on every read would bring the
// picture from the server again and again.
const attachmentDataUrls = new Map();

const attachmentFetches = new Map();
const ATTACHMENT_CACHE_MAX_ENTRIES = 24;

function rememberAttachmentResult(attachmentId, result) {
  // Oldest out first. Without a bound, scrolling a long history keeps every
  // picture ever opened in memory for the life of the session.
  if (attachmentDataUrls.size >= ATTACHMENT_CACHE_MAX_ENTRIES) {
    const oldest = attachmentDataUrls.keys().next();
    if (!oldest.done) {
      attachmentDataUrls.delete(oldest.value);
    }
  }
  attachmentDataUrls.set(attachmentId, result);
}

function loadAttachmentInto(image, conversationId, attachment, messageId) {
  if (attachment.dataBase64) {
    // Already in hand — a picture queued on this phone, not yet echoed back.
    applyAttachmentResult(image, "data:" + attachment.mimeType + ";base64," + attachment.dataBase64);
    return;
  }
  const cached = attachmentDataUrls.get(attachment.id);
  if (cached) {
    applyAttachmentResult(image, cached);
    return;
  }
  if (!attachmentFetches.has(attachment.id)) {
    attachmentFetches.set(attachment.id, (async function () {
      // From the server the picture is read by its message: the server
      // holds the body the device that posted it put there.
      const payload = await hubPhoneGet("/v1/phone/attachment", { conversationId: conversationId, attachmentId: attachment.id, messageId: messageId });
      if (payload && payload.type === "mobile.attachment" && typeof payload.dataBase64 === "string") {
        const mimeType = typeof payload.mimeType === "string" ? payload.mimeType : attachment.mimeType;
        return "data:" + mimeType + ";base64," + payload.dataBase64;
      }
      // "too-large" and "unavailable" are answers, not failures: the row says
      // so instead of spinning forever.
      return payload && typeof payload.reason === "string" ? payload.reason : "unavailable";
    })().catch(function () {
      // A dropped connection is not an answer: leave it uncached so opening
      // the chat again retries instead of showing a permanent failure.
      return "retry";
    }).then(function (result) {
      if (result !== "retry") {
        rememberAttachmentResult(attachment.id, result);
      }
      attachmentFetches.delete(attachment.id);
      return result === "retry" ? "unavailable" : result;
    }));
  }
  attachmentFetches.get(attachment.id).then(function (result) {
    if (image.isConnected) {
      applyAttachmentResult(image, result);
    }
  });
}

function applyAttachmentResult(image, result) {
  if (result && result.indexOf("data:") === 0) {
    image.src = result;
    image.dataset.state = "ready";
    return;
  }
  // A replaced element renders no pseudo-element, so the reason goes in a
  // sibling the reader can actually see.
  image.dataset.state = result === "too-large" ? "too-large" : "unavailable";
  image.hidden = true;
  const note = image.nextElementSibling;
  if (note && note.classList.contains("message-image-note")) {
    note.textContent = result === "too-large"
      ? "Too large for the phone — open it on the desktop"
      : "Image unavailable";
    note.hidden = false;
  }
}

export function renderAttachmentsInto(container, entry) {
  const attachments = Array.isArray(entry.attachments) ? entry.attachments : [];
  const signature = attachments.map(function (attachment) { return attachment.id; }).join(",");
  if (container.dataset.attachmentSignature === signature) {
    return;
  }
  container.dataset.attachmentSignature = signature;
  container.textContent = "";
  if (attachments.length === 0) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  for (const attachment of attachments) {
    const image = document.createElement("img");
    image.className = "message-image";
    image.alt = attachment.filename;
    image.dataset.state = "loading";
    image.loading = "lazy";
    if (attachment.width && attachment.height) {
      // Reserve the real box before the bytes land, so the timeline does not
      // jump under the reader when the picture appears.
      image.width = attachment.width;
      image.height = attachment.height;
    }
    const note = document.createElement("div");
    note.className = "message-image-note";
    note.hidden = true;
    // A loaded picture opens at full size; one that has no bytes yet, or
    // never will, stays a note in the row.
    image.addEventListener("click", function () {
      if (image.dataset.state === "ready" && image.src) {
        openImageViewer(image.src, attachment.filename);
      }
    });
    container.append(image, note);
    loadAttachmentInto(image, entry.conversationId, attachment, entry.messageId || entry.sourceId);
  }
}

export function openImageViewer(src, alt) {
  const viewer = document.getElementById("image-viewer");
  const picture = document.getElementById("image-viewer-image");
  if (!viewer || !picture) {
    return;
  }
  picture.src = src;
  picture.alt = alt || "Picture";
  viewer.hidden = false;
  // The bar leaves and comes back with the viewer; a reader at the latest
  // message stays there across both, as across the keyboard.
  keepingReaderAtLatest(applyDock);
}

export function closeImageViewer() {
  const viewer = document.getElementById("image-viewer");
  const picture = document.getElementById("image-viewer-image");
  if (!viewer || viewer.hidden) {
    return;
  }
  viewer.hidden = true;
  if (picture) {
    picture.removeAttribute("src");
  }
  keepingReaderAtLatest(applyDock);
}

export function wireImageViewer() {
  const viewer = document.getElementById("image-viewer");
  const close = document.getElementById("image-viewer-close");
  if (!viewer) {
    return;
  }
  close?.addEventListener("click", closeImageViewer);
  // Anywhere outside the picture itself is "back": the dark backdrop and the
  // picture's own margins. Scrolling inside a tall picture must not close it.
  viewer.addEventListener("click", function (event) {
    if (event.target === viewer || (event.target instanceof Element && event.target.classList.contains("image-viewer-body"))) {
      closeImageViewer();
    }
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      closeImageViewer();
    }
  });
}

export function attachmentsNodeFor(parent) {
  let node = parent.querySelector(".message-images");
  if (!node) {
    node = document.createElement("div");
    node.className = "message-images";
    node.hidden = true;
    parent.append(node);
  }
  return node;
}
