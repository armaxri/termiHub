import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { drainSonnerRemovalTimers } from "@/test/sonnerTimers";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ToastProvider } from "./ToastProvider";
import { toast } from "./toast";
import {
  TOAST_AVOID_ATTR,
  TOAST_AVOID_FORM_ATTR,
  TOAST_AVOID_INSET_VAR,
  TOAST_PINNED_CLASS,
} from "./toastAvoid";
import { Modal } from "../Modal";

/**
 * Toast placement around forms, the status bar and dialogs (#5830), at the
 * 800x600 minimum window where the stack has the least room.
 */

let container: HTMLDivElement;
let root: Root;
const extras: HTMLElement[] = [];
const original = { width: window.innerWidth, height: window.innerHeight };

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

async function tick(ms = 25) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function waitFor(predicate: () => boolean, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error("waitFor: condition not met within budget");
}

/** A marked element with a fixed viewport box. */
function place(
  attr: string,
  rect: { left: number; top: number; right: number; bottom: number }
): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute(attr, "");
  el.getBoundingClientRect = () =>
    ({ ...rect, width: rect.right - rect.left, height: rect.bottom - rect.top }) as DOMRect;
  document.body.appendChild(el);
  extras.push(el);
  return el;
}

/** The status bar: full width, 24px tall, at the bottom of the 800x600 window. */
const placeStatusBar = () =>
  place(TOAST_AVOID_ATTR, { left: 0, top: 576, right: 800, bottom: 600 });

/** A connection editor's footer and form body, right of a 48px activity bar. */
function placeEditor() {
  place(TOAST_AVOID_ATTR, { left: 48, top: 528, right: 800, bottom: 576 });
  place(TOAST_AVOID_FORM_ATTR, { left: 48, top: 104, right: 800, bottom: 528 });
}

const toaster = () => document.querySelector("[data-sonner-toaster]") as HTMLElement | null;
const inToasts = (text: string) =>
  Array.from(document.querySelectorAll("[data-sonner-toast]")).some((el) =>
    (el.textContent ?? "").includes(text)
  );
const modalStatus = () => document.querySelector('[data-testid="modal-status"]');

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { value: 800, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 600, configurable: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  toast.dismiss();
  act(() => root.unmount());
  container.remove();
  for (const el of extras.splice(0)) el.remove();
  Object.defineProperty(window, "innerWidth", { value: original.width, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: original.height, configurable: true });
});

// A toast dismissed by the last test must not outlive jsdom (see the helper).
afterAll(drainSonnerRemovalTimers);

describe("toast stack keep-clear at 800x600 (#5830)", () => {
  it("starts the stack above the status bar, clear of its lock indicator", async () => {
    placeStatusBar();
    render(<ToastProvider />);
    act(() => {
      toast.success("Credential store unlocked");
    });
    await waitFor(() => inToasts("Credential store unlocked"));
    expect(document.documentElement.style.getPropertyValue(TOAST_AVOID_INSET_VAR)).toBe("24px");
    expect(toaster()?.getAttribute("data-y-position")).toBe("bottom");
    expect(document.documentElement.classList.contains(TOAST_PINNED_CLASS)).toBe(false);
  });

  it("pins the stack top-right above an open editor's form fields", async () => {
    placeStatusBar();
    placeEditor();
    render(<ToastProvider />);
    act(() => {
      toast.success("Closed “Terminal”", { action: { label: "Reopen", onClick: () => {} } });
    });
    await waitFor(() => inToasts("Closed “Terminal”"));
    const t = toaster()!;
    expect(t.getAttribute("data-y-position")).toBe("top");
    expect(t.getAttribute("data-x-position")).toBe("right");
    // 104 (form top) - 32 (one compact toast) - 2 (gap): the toast ends above the form.
    expect(t.style.getPropertyValue("--offset-top")).toBe("70px");
    expect(document.documentElement.classList.contains(TOAST_PINNED_CLASS)).toBe(true);
  });

  it("goes back to the bottom-right once the editor closes", async () => {
    placeStatusBar();
    placeEditor();
    render(<ToastProvider />);
    act(() => {
      toast.success("Saved");
    });
    await waitFor(() => toaster()?.getAttribute("data-y-position") === "top");
    act(() => {
      for (const el of extras.splice(1)) el.remove();
    });
    await waitFor(() => toaster()?.getAttribute("data-y-position") === "bottom");
    expect(document.documentElement.classList.contains(TOAST_PINNED_CLASS)).toBe(false);
  });
});

describe("toasts and an opening dialog (#5830)", () => {
  function App({ open }: { open: boolean }) {
    return (
      <>
        <ToastProvider />
        <Modal
          open={open}
          onOpenChange={() => {}}
          title="Clear run history?"
          footer={<button type="button">Clear history</button>}
        >
          <p>All runs are removed.</p>
        </Modal>
      </>
    );
  }

  it("dismisses lingering success toasts when a dialog opens, keeping errors", async () => {
    render(<App open={false} />);
    act(() => {
      toast.success("Played macro “deploy”");
      toast.info("Disabled schedule “nightly”");
      toast.error("Sync failed");
    });
    await waitFor(() => inToasts("Played macro") && inToasts("Sync failed"));
    render(<App open />);
    await waitFor(() => !inToasts("Played macro") && !inToasts("Disabled schedule"));
    expect(inToasts("Sync failed")).toBe(true);
  });

  it("shows feedback raised inside the dialog in its status line, not a toast", async () => {
    render(<App open />);
    await tick();
    act(() => {
      toast.success("Copied run log");
    });
    await waitFor(() => (modalStatus()?.textContent ?? "").includes("Copied run log"));
    expect(modalStatus()?.getAttribute("role")).toBe("status");
    expect(modalStatus()?.getAttribute("data-kind")).toBe("success");
    await tick(100);
    expect(inToasts("Copied run log")).toBe(false);
  });

  it("keeps a toast with a button (and errors) in the stack while a dialog is open", async () => {
    render(<App open />);
    await tick();
    act(() => {
      toast.success("Closed “web”", { action: { label: "Reopen", onClick: () => {} } });
      toast.error("Clear failed");
    });
    await waitFor(() => inToasts("Closed “web”") && inToasts("Clear failed"));
    expect(modalStatus()?.textContent).toBe("");
  });

  it("clears the status line when the dialog closes", async () => {
    render(<App open />);
    await tick();
    const id = "inline-1";
    act(() => {
      toast.info("History cleared", { id });
    });
    await waitFor(() => (modalStatus()?.textContent ?? "").includes("History cleared"));
    expect(toast.isActive(id)).toBe(true);
    render(<App open={false} />);
    await waitFor(() => modalStatus() === null);
    expect(toast.isActive(id)).toBe(false);
  });
});
