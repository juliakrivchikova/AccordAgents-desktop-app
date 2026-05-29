const http = require("node:http");
const WebSocket = require("ws");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9222;
const DEFAULT_TITLE = "AccordAgents";

function getJson(path, { host = DEFAULT_HOST, port = DEFAULT_PORT, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://${host}:${port}${path}`, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`CDP HTTP timeout after ${timeoutMs}ms`)));
    req.on("error", reject);
  });
}

async function attach({
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  title = DEFAULT_TITLE,
  timeoutMs = 10000
} = {}) {
  const targets = await getJson("/json", { host, port, timeoutMs });
  const page = targets.find((t) => t.type === "page" && t.title === title);
  if (!page) throw new Error("AccordAgents page not found among CDP targets");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP WebSocket timeout after ${timeoutMs}ms`)), timeoutMs);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", reject);
  });

  let nextId = 1;
  const pending = new Map();
  const eventListeners = new Map();

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const request = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(request.timer);
      if (msg.error) request.reject(new Error(`${request.method}: ${msg.error.message}`));
      else request.resolve(msg.result);
      return;
    }

    if (!msg.method || !eventListeners.has(msg.method)) return;
    for (const listener of [...eventListeners.get(msg.method)]) {
      listener(msg.params);
    }
  });

  const send = (method, params = {}, { timeoutMs: requestTimeoutMs = timeoutMs } = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timeout after ${requestTimeoutMs}ms`));
      }, requestTimeoutMs);
      pending.set(id, { method, resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const waitForEvent = (method, { timeoutMs: eventTimeoutMs = timeoutMs, predicate = () => true } = {}) =>
    new Promise((resolve, reject) => {
      const listener = (params) => {
        if (!predicate(params)) return;
        clearTimeout(timer);
        eventListeners.get(method)?.delete(listener);
        resolve(params);
      };
      const timer = setTimeout(() => {
        eventListeners.get(method)?.delete(listener);
        reject(new Error(`${method} event timeout after ${eventTimeoutMs}ms`));
      }, eventTimeoutMs);
      if (!eventListeners.has(method)) eventListeners.set(method, new Set());
      eventListeners.get(method).add(listener);
    });

  const evaluate = async (expression, params = {}, sendOptions = {}) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      ...params
    }, sendOptions);
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(description);
    }
    return result;
  };

  const waitForSelector = async (selector, { timeoutMs: selectorTimeoutMs = timeoutMs } = {}) => {
    const result = await evaluate(`new Promise((resolve, reject) => {
      const selector = ${JSON.stringify(selector)};
      const deadline = Date.now() + ${selectorTimeoutMs};
      const tick = () => {
        const element = document.querySelector(selector);
        if (element) {
          resolve(true);
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error("Selector not found: " + selector));
          return;
        }
        requestAnimationFrame(tick);
      };
      tick();
    })`, {}, { timeoutMs: selectorTimeoutMs + 1000 });
    return result.result.value;
  };

  const click = async (selector) => {
    await waitForSelector(selector);
    await evaluate(`(() => {
      const selector = ${JSON.stringify(selector)};
      const element = document.querySelector(selector);
      if (!element) throw new Error("Selector not found: " + selector);
      element.click();
      return true;
    })()`);
  };

  const fill = async (selector, value) => {
    await waitForSelector(selector);
    await evaluate(`(() => {
      const selector = ${JSON.stringify(selector)};
      const element = document.querySelector(selector);
      if (!element) throw new Error("Selector not found: " + selector);
      const value = ${JSON.stringify(value)};
      element.focus();
      if ("value" in element) {
        const prototype = Object.getPrototypeOf(element);
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
        if (descriptor?.set) descriptor.set.call(element, value);
        else element.value = value;
      } else if (element.isContentEditable) {
        element.textContent = value;
      } else {
        throw new Error("Element is not fillable: " + selector);
      }
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);
  };

  const screenshot = async ({ format = "png", quality = 100, timeoutMs: screenshotTimeoutMs = timeoutMs } = {}) => {
    await send("Page.enable");
    const framePromise = waitForEvent("Page.screencastFrame", { timeoutMs: screenshotTimeoutMs });
    await send("Page.startScreencast", { format, quality, everyNthFrame: 1 });
    try {
      const frame = await framePromise;
      await send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
      return {
        data: Buffer.from(frame.data, "base64"),
        metadata: frame.metadata
      };
    } finally {
      await send("Page.stopScreencast").catch(() => {});
    }
  };

  return {
    send,
    evaluate,
    waitForEvent,
    waitForSelector,
    click,
    fill,
    screenshot,
    close: () => ws.close()
  };
}

module.exports = { attach, getJson };
