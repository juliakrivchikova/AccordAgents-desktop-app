// Installs a DOM before any test module is evaluated.
//
// This must run via `node --import`, not from inside a test file. Radix binds
// its `useLayoutEffect` to a no-op at module-evaluation time when
// `globalThis.document` is undefined, and esbuild hoists the bundle's
// `import ... from "radix-ui"` above the test body — so a jsdom installed
// inside the test arrives too late, the dialog portal never mounts, and the
// page renders empty with no error to explain it.
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://desktop.test/" });
const win = dom.window;

Object.defineProperty(globalThis, "window", { configurable: true, value: win });
for (const key of Object.getOwnPropertyNames(win)) {
  if (key === "window" || key === "globalThis" || key in globalThis) {
    continue;
  }
  try {
    Object.defineProperty(globalThis, key, { configurable: true, get: () => win[key] });
  } catch {
    // Some jsdom accessors refuse redefinition; nothing in the renderer needs them.
  }
}

// Node ships its own Event/CustomEvent/EventTarget. jsdom's dispatchEvent
// rejects an Event from a foreign realm, so these must be jsdom's — otherwise
// Radix's dismissable layer throws on mount.
for (const key of ["document", "navigator", "Event", "CustomEvent", "EventTarget", "MessageEvent", "AbortController", "AbortSignal"]) {
  if (win[key] !== undefined) {
    Object.defineProperty(globalThis, key, { configurable: true, value: win[key] });
  }
}

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
win.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
win.Element.prototype.scrollIntoView ??= () => undefined;
win.Element.prototype.hasPointerCapture ??= () => false;
win.Element.prototype.releasePointerCapture ??= () => undefined;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// Marker a DOM-needing test asserts on its first line. Without it the failure
// mode is an empty page and no error at all, which costs hours to diagnose —
// the assertion turns that into a message naming the script to run.
globalThis.ACCORD_RENDERER_JSDOM = true;
