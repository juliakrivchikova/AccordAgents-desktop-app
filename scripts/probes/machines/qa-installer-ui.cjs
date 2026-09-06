#!/usr/bin/env node
/**
 * Drives the real Settings → Machines install/upgrade UI over CDP.
 * Usage: node qa-installer-ui.cjs <step> [args]
 * Steps: open, add <name>, setup <machineId> <host> <user> <key> <root>,
 *        run, mirror, state
 */
const { attach } = require("../../cdp.cjs");
const PORT = Number(process.env.QA_PORT || 9236);

async function main() {
  const app = await attach({ port: PORT });
  const step = process.argv[2];
  const args = process.argv.slice(3);
  const evaluate = async (expression) => {
    const result = await app.evaluate(expression);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
    }
    return result.result.value;
  };
  const out = await evaluate(SCRIPTS[step](...args));
  console.log(JSON.stringify(out, null, 1));
  app.close();
}

const click = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { ok: false, reason: "not found: " + ${JSON.stringify(selector)} };
  el.scrollIntoView({ block: "center" });
  el.click();
  return { ok: true };
})()`;

const setInput = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { ok: false, reason: "not found: " + ${JSON.stringify(selector)} };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return { ok: true, value: el.value };
})()`;

const SCRIPTS = {
  open: () => `(() => {
    const settings = [...document.querySelectorAll("button")].find((b) => (b.innerText || "").trim() === "Settings");
    if (settings) settings.click();
    return { opened: Boolean(settings) };
  })()`,
  general: () => `(() => {
    const item = [...document.querySelectorAll("button, a, li")].find((b) => (b.innerText || "").trim() === "General");
    if (item) item.click();
    return { clicked: Boolean(item) };
  })()`,
  scroll: () => `(() => {
    const section = document.querySelector('[data-testid="machines-section"]');
    if (section) section.scrollIntoView({ block: "center" });
    return { found: Boolean(section), text: section ? section.innerText.slice(0, 600) : "" };
  })()`,
  name: (value) => setInput('[data-testid="machine-name-input"]', value),
  add: () => click('[data-testid="machine-add"]'),
  toggleSetup: () => click('[data-testid="machine-setup-toggle"]'),
  host: (value) => setInput('[data-testid="machine-setup-host"]', value),
  user: (value) => setInput('[data-testid="machine-setup-user"]', value),
  key: (value) => setInput('[data-testid="machine-setup-key"]', value),
  root: (value) => setInput('[data-testid="machine-setup-root"]', value),
  provider: (value) => `(() => {
    const el = document.querySelector('[data-testid="machine-setup-provider"]');
    if (!el) return { ok: false };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, value: el.value };
  })()`,
  run: () => click('[data-testid="machine-setup-run"]'),
  mirror: () => click('[data-testid="machine-setup-mirror"]'),
  state: () => `(() => {
    const panel = document.querySelector('[data-testid="machine-setup-panel"]');
    const progress = document.querySelector('[data-testid="machine-setup-progress"]');
    const steps = [...document.querySelectorAll('[data-testid="machine-setup-progress"] li')].map((li) => ({
      step: li.getAttribute("data-step"), state: li.getAttribute("data-state")
    }));
    const row = document.querySelector('[data-testid="machine-row"]');
    return {
      machineId: panel ? panel.getAttribute("data-machine") : null,
      rowText: row ? row.innerText.replace(/\\n/g, " | ") : null,
      phase: progress ? progress.getAttribute("data-phase") : null,
      message: document.querySelector('[data-testid="machine-setup-message"]')?.innerText ?? null,
      auth: document.querySelector('[data-testid="machine-setup-auth"]')?.innerText ?? null,
      recovery: document.querySelector('[data-testid="machine-setup-recovery"]')?.innerText ?? null,
      recoveryKind: document.querySelector('[data-testid="machine-setup-recovery"]')?.getAttribute("data-kind") ?? null,
      mirror: document.querySelector('[data-testid="machine-setup-mirror-result"]')?.innerText ?? null,
      mirrorAction: document.querySelector('[data-testid="machine-setup-mirror-result"]')?.getAttribute("data-action") ?? null,
      error: document.querySelector('[data-testid="machine-setup-error"]')?.innerText ?? null,
      steps
    };
  })()`
};

main().catch((error) => { console.error("QA_ERROR", error.message); process.exit(1); });
