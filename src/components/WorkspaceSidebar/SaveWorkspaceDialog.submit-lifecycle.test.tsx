/**
 * Submit-lifecycle parity for SaveWorkspaceDialog (#1469).
 *
 * The footer Save Button is a `type="submit"` associated with the body <form>
 * via `form=`. Both entry points must behave identically:
 *  - a mouse **click** drives the async Button lifecycle (pending affordance),
 *  - pressing **Enter** (form submit) drives the *same* pending affordance,
 *  - a single gate (empty name) governs both paths.
 *
 * Before #1469 the Enter path ran the bare form handler with no Button
 * lifecycle, so it showed no pending spinner — these are the regression guard.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { SaveWorkspaceDialog } from "./SaveWorkspaceDialog";

let container: HTMLDivElement;
let root: Root;

const baseProps = {
  tabGroupCount: 1,
  activeGroupName: "Group 1",
  onSave: () => {},
  onCancel: () => {},
};

/** A promise whose resolution the test controls, to freeze the pending state. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

// The dialog renders inside a Radix Modal portal (document.body), not the
// mount container — query the whole document.
function get<T extends HTMLElement>(testId: string): T {
  return document.querySelector<T>(`[data-testid="${testId}"]`)!;
}

function setValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function fillName(value: string) {
  await act(async () => setValue(get<HTMLInputElement>("save-workspace-name"), value));
  await flush();
}

async function fireSubmit() {
  await act(async () => {
    get<HTMLFormElement>("save-workspace-form").dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true })
    );
  });
  await flush();
}

async function fireClick() {
  await act(async () => {
    get<HTMLButtonElement>("save-workspace-confirm").dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true })
    );
  });
  await flush();
}

function isPending(button: HTMLButtonElement): boolean {
  return (
    button.classList.contains("ui-btn--pending") && button.getAttribute("aria-busy") === "true"
  );
}

describe("SaveWorkspaceDialog — submit lifecycle parity (#1469)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("clicking Save drives the async pending affordance", async () => {
    const gate = deferred();
    const onSave = vi.fn(() => gate.promise);
    await act(async () => root.render(<SaveWorkspaceDialog {...baseProps} onSave={onSave} />));
    await fillName("My Layout");

    await fireClick();

    expect(onSave).toHaveBeenCalledWith("My Layout", "all", undefined);
    expect(isPending(get<HTMLButtonElement>("save-workspace-confirm"))).toBe(true);
    gate.resolve();
  });

  it("pressing Enter drives the SAME pending affordance as clicking", async () => {
    const gate = deferred();
    const onSave = vi.fn(() => gate.promise);
    await act(async () => root.render(<SaveWorkspaceDialog {...baseProps} onSave={onSave} />));
    await fillName("My Layout");

    await fireSubmit();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(isPending(get<HTMLButtonElement>("save-workspace-confirm"))).toBe(true);
    gate.resolve();
  });

  it("shares one gate: an empty name runs neither Enter nor click", async () => {
    const onSave = vi.fn(() => Promise.resolve());
    await act(async () => root.render(<SaveWorkspaceDialog {...baseProps} onSave={onSave} />));

    expect(get<HTMLButtonElement>("save-workspace-confirm").disabled).toBe(true);
    await fireSubmit();
    await act(async () => get<HTMLButtonElement>("save-workspace-confirm").click());
    await flush();
    expect(onSave).not.toHaveBeenCalled();
  });
});
