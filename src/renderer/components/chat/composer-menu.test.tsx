import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { AppSelect } from "../primitives";
import { ComposerMenu } from "./composer-menu";

test("a select opened from a composer menu takes its choice: its list, in a portal outside the menu, does not close the menu", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const chosen: string[] = [];
  const menuOpen = (): boolean => Boolean(document.querySelector("[data-testid=\"probe-menu\"]"));
  const listOpen = (): boolean => Boolean(document.querySelector("[role=listbox]"));
  const settle = async (): Promise<void> => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); }); };
  const trigger = (): HTMLElement => document.querySelector<HTMLElement>("[data-testid=\"probe-select\"]")!;
  const openList = async (): Promise<void> => {
    await act(async () => { trigger().focus(); trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await settle();
    assert.ok(listOpen(), "the list opens");
  };
  const option = (label: string): HTMLElement => [...document.querySelectorAll<HTMLElement>("[role=option]")].find((item) => item.textContent?.trim() === label)!;
  try {
    // Runs on in the sessions composer: the kit select inside a ComposerMenu.
    await act(async () => {
      root.render(<ComposerMenu testId="probe" title="Probe" label="Probe">
        {() => <AppSelect value="local" options={[{ value: "local", label: "Local" }, { value: "box", label: "Box" }]} placeholder="Run on" ariaLabel="Run on" testId="probe-select" onValueChange={(value) => chosen.push(value)} />}
      </ComposerMenu>);
    });
    await act(async () => { document.querySelector<HTMLButtonElement>("[data-testid=\"probe\"]")!.click(); });

    await openList();
    await act(async () => { option("Box").dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    assert.ok(menuOpen(), "a press on the list keeps the menu, so the list can take the choice");
    await act(async () => { option("Box").click(); });
    await settle();
    assert.deepEqual(chosen, ["box"], "the choice lands");

    await openList();
    await act(async () => { option("Local").focus(); option("Local").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await settle();
    assert.equal(listOpen(), false, "Escape closes the list");
    assert.ok(menuOpen(), "and not the menu under it");

    // While the list is open the page takes no pointer events: a press anywhere lands
    // on the document root. It closes the list and must not reach the menu as a mouse
    // press outside it, so the list cancels it (no mousedown follows a cancelled press).
    await openList();
    await settle();
    const press = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
    await act(async () => { document.documentElement.dispatchEvent(press); });
    await settle();
    assert.ok(press.defaultPrevented, "the press that closes the list is the list's");
    assert.equal(listOpen(), false);
    assert.ok(menuOpen());

    await act(async () => { document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    assert.equal(menuOpen(), false, "a press outside still closes the menu");
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
  }
});
