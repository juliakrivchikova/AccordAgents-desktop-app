import { createEventId } from "../base/bytes.js";
import { composerStopState, syncComposerStop } from "./composerStop.js";
import { afterTapLands, updateComposerShape } from "../shell/home.js";

export const pickedImagesState = {
  // Pictures being read and resized after a pick: the draft is not empty
  // while they are on their way (the composer's Stop waits for them).
  attachmentsPreparing: 0
};

// Pictures chosen on the phone, waiting for the next send. Same limits the
// desktop composer enforces, checked here so the refusal is visible where the
// picture was chosen rather than deep in the relay.
const MOBILE_UPLOAD_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];

const MOBILE_UPLOAD_MAX_IMAGES = 5;
const MOBILE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
const MOBILE_UPLOAD_MAX_TOTAL_BYTES = 8 * 1024 * 1024;

// The models downscale anything above this before looking, so sending more
// costs the same tokens and only burns relay bandwidth and phone storage.
const MOBILE_UPLOAD_MAX_EDGE = 2576;

// A guard on what we are willing to decode at all, before any resizing. A
// compressed byte count is a poor proxy for decoded memory — a 12 MB JPEG can
// still be tens of megapixels — so this is deliberately conservative.
const MOBILE_UPLOAD_MAX_SOURCE_BYTES = 12 * 1024 * 1024;

export let pendingAttachments = [];

function readFileAsBase64(file) {
  return new Promise(function (resolve, reject) {
    const reader = new FileReader();
    reader.onerror = function () {
      reject(new Error("read-failed"));
    };
    reader.onload = function () {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : "");
    };
    reader.readAsDataURL(file);
  });
}

// JPEG is lossy and has no transparency, so only a JPEG stays a JPEG. PNG and
// WebP both become PNG: lossless, alpha preserved, and encodable on every
// engine that runs this app.
function preparedImageMimeType(sourceMimeType) {
  return sourceMimeType === "image/jpeg" ? "image/jpeg" : "image/png";
}

function preparedImageFilename(filename, mimeType) {
  const base = String(filename || "image").replace(/\.[A-Za-z0-9]+$/, "");
  return base + (mimeType === "image/jpeg" ? ".jpg" : ".png");
}

async function decodeOrientedImage(file) {
  // createImageBitmap with imageOrientation is the direct route, but it is not
  // everywhere: older WebKit either lacks the function or ignores the option.
  // Falling through to an <img>, which honours EXIF on its own, keeps a phone
  // that cannot do the first route from losing the picture entirely.
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // fall through
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    if (typeof image.decode === "function") {
      await image.decode();
    } else {
      await new Promise(function (resolve, reject) {
        image.onload = resolve;
        image.onerror = reject;
      });
    }
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function preparePickedImage(file) {
  // Orientation is baked into the pixels here. Models do not read image
  // metadata at all, so a photo taken sideways reaches them sideways — which
  // is exactly what happened to the first picture sent from the phone.
  const source = await decodeOrientedImage(file);
  try {
    const sourceWidth = source.width || source.naturalWidth;
    const sourceHeight = source.height || source.naturalHeight;
    if (!sourceWidth || !sourceHeight) {
      throw new Error("decode-failed");
    }
    const scale = Math.min(1, MOBILE_UPLOAD_MAX_EDGE / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(source, 0, 0, width, height);
    const mimeType = preparedImageMimeType(file.type);
    const blob = await new Promise(function (resolve) {
      canvas.toBlob(resolve, mimeType, 0.9);
    });
    if (!blob) {
      throw new Error("encode-failed");
    }
    return {
      mimeType,
      filename: preparedImageFilename(file.name, mimeType),
      dataBase64: await readFileAsBase64(blob),
      width,
      height
    };
  } finally {
    if (source && typeof source.close === "function") {
      source.close();
    }
  }
}

/** Prepares pictures picked for a message and adds them to its list: the
 *  chat's composer's, unless another one is named (New chat's, as a
 *  function giving its list). The list is read when it is used, not before
 *  the picture is prepared: a send, a start or a removed picture meanwhile
 *  replaces it, and a picture added to the replaced one was lost. */
export async function addPendingAttachments(files, target) {
  const rejected = [];
  const currentList = function () { return target ? target() : pendingAttachments; };
  for (const file of Array.from(files || [])) {
    if (currentList().length >= MOBILE_UPLOAD_MAX_IMAGES) {
      rejected.push(file.name + " — too many pictures");
      continue;
    }
    if (MOBILE_UPLOAD_MIME_TYPES.indexOf(file.type) < 0) {
      rejected.push(file.name + " — not a PNG, JPEG or WebP");
      continue;
    }
    if (file.size > MOBILE_UPLOAD_MAX_SOURCE_BYTES) {
      rejected.push(file.name + " — too large to open");
      continue;
    }
    try {
      // Resize first: the limits below apply to what actually travels, so a
      // 12 MP photo is accepted rather than refused for a size it will not
      // have by the time it is sent.
      const prepared = await preparePickedImage(file);
      const bytes = Math.floor((prepared.dataBase64.length * 3) / 4);
      if (!prepared.dataBase64 || bytes <= 0) {
        rejected.push(file.name + " — could not be read");
        continue;
      }
      if (bytes > MOBILE_UPLOAD_MAX_BYTES) {
        rejected.push(file.name + " — larger than 4 MB");
        continue;
      }
      // Five 4 MB pictures would be a 27 MB base64 payload in IndexedDB and
      // one relay frame. The batch is bounded as well as each picture.
      const list = currentList();
      if (list.length >= MOBILE_UPLOAD_MAX_IMAGES) {
        rejected.push(file.name + " — too many pictures");
        continue;
      }
      const pendingBytes = list.reduce(function (total, item) {
        return total + Math.floor((item.dataBase64.length * 3) / 4);
      }, 0);
      if (pendingBytes + bytes > MOBILE_UPLOAD_MAX_TOTAL_BYTES) {
        rejected.push(file.name + " — over the 8 MB total");
        continue;
      }
      list.push({
        id: createEventId(),
        filename: prepared.filename,
        mimeType: prepared.mimeType,
        dataBase64: prepared.dataBase64
      });
    } catch {
      rejected.push(file.name + " — could not be read");
    }
  }
  return rejected;
}

export function renderPendingAttachments() {
  // A picture is something to send: the main composer's Stop turns back
  // into Send, and Stop returns once the last picture is taken off.
  syncComposerStop(composerStopState);
  const strip = document.getElementById("composer-attachments");
  if (!strip) {
    return;
  }
  strip.textContent = "";
  // A picture waiting to be sent keeps the composer open, the same as text.
  // Folding waits for the tap in progress: a send takes the pictures while
  // the finger is still on Send.
  if (pendingAttachments.length > 0) {
    updateComposerShape();
  } else {
    afterTapLands(updateComposerShape);
  }
  if (pendingAttachments.length === 0) {
    strip.hidden = true;
    return;
  }
  strip.hidden = false;
  for (const attachment of pendingAttachments) {
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
      pendingAttachments = pendingAttachments.filter(function (item) {
        return item.id !== attachment.id;
      });
      renderPendingAttachments();
    });
    chip.append(thumb, remove);
    strip.append(chip);
  }
}

export function takePendingAttachments() {
  const taken = pendingAttachments.map(function (attachment) {
    return {
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      dataBase64: attachment.dataBase64
    };
  });
  pendingAttachments = [];
  renderPendingAttachments();
  return taken;
}
