/**
 * The coalesced reopen toast in the real toast host (#5828): three tab closes
 * render ONE "Closed 3 tabs" toast in the DOM, and its "Reopen all" button
 * restores all three tabs in order.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ToastProvider, toast } from "@/components/ui";
import type { ReopenTabPayload } from "@/types/terminal";

const addTab = vi.fn();
vi.mock("@/store/appStore", () => ({
  useAppStore: { getState: () => ({ addTab }) },
}));

import { resetReopenToastBatch, showReopenToast } from "./reopenTab";

const REOPEN_TOAST_TEST_ID = "reopen-tab-toast";
const REOPEN_TOAST_ACTION_TEST_ID = "reopen-tab-toast-action";

let container: HTMLDivElement;
let root: Root;

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

function payload(title: string): ReopenTabPayload {
  return { title, connectionType: "local", config: { type: "local", config: {} } as never };
}

function reopenToasts(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(`[data-testid="${REOPEN_TOAST_TEST_ID}"]`)
  ).filter((el) => el.getAttribute("data-removed") !== "true");
}

describe("reopen toast in the toast host (#5828)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    addTab.mockClear();
    resetReopenToastBatch();
    act(() => root.render(<ToastProvider />));
  });

  afterEach(() => {
    toast.dismiss();
    act(() => root.unmount());
    container.remove();
  });

  it("a single close names the tab", async () => {
    act(() => showReopenToast(payload("web-1")));
    await waitFor(() => reopenToasts().length === 1);
    expect(reopenToasts()[0].textContent).toContain("Closed “web-1”");
    expect(reopenToasts()[0].textContent).toContain("Reopen");
  });

  it("three closes show one toast whose Reopen all restores all three in order", async () => {
    act(() => showReopenToast(payload("a")));
    await tick();
    act(() => showReopenToast(payload("b")));
    await tick();
    act(() => showReopenToast(payload("c")));
    await waitFor(() => (reopenToasts()[0]?.textContent ?? "").includes("Closed 3 tabs"));
    expect(reopenToasts()).toHaveLength(1);
    expect(document.querySelectorAll("[data-sonner-toast]")).toHaveLength(1);
    expect(reopenToasts()[0].textContent).toContain("a, b, c");

    const label = document.querySelector<HTMLElement>(
      `[data-testid="${REOPEN_TOAST_ACTION_TEST_ID}"]`
    );
    expect(label?.textContent).toBe("Reopen all");
    act(() => label!.click());
    expect(addTab.mock.calls.map((c) => c[0])).toEqual(["a", "b", "c"]);
    await waitFor(() => reopenToasts().length === 0);
  });
});

/**
 * #5904: closing an exited terminal tab showed no reopen toast. The exited
 * session's notice is a keep-clear zone; while it covered the pane the stack
 * docked and deferred success toasts. Closing the tab removed the notice in the
 * same moment the toast was raised, so the toast was queued (and its id
 * dismissed) and re-shown a frame later, and the dismiss still in flight inside
 * sonner then took the re-shown toast down again.
 */
describe("reopen toast when the closed tab's keep-clear notice goes with it (#5904)", () => {
  const original = { width: window.innerWidth, height: window.innerHeight };
  let notice: HTMLDivElement;

  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { value: 800, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 600, configurable: true });
    // A keep-clear box over the whole terminal pane: no room above or beside
    // it, so the stack docks.
    notice = document.createElement("div");
    notice.setAttribute("data-toast-avoid", "");
    notice.getBoundingClientRect = () =>
      ({ left: 200, top: 40, right: 800, bottom: 576, width: 600, height: 536 }) as DOMRect;
    document.body.appendChild(notice);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    addTab.mockClear();
    resetReopenToastBatch();
    act(() => root.render(<ToastProvider />));
  });

  afterEach(() => {
    toast.dismiss();
    act(() => root.unmount());
    container.remove();
    notice.remove();
    Object.defineProperty(window, "innerWidth", { value: original.width, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: original.height, configurable: true });
  });

  it("shows the toast and keeps it once the stack undocks", async () => {
    expect(document.documentElement.classList.contains("th-toast-docked")).toBe(true);
    act(() => {
      notice.remove();
      showReopenToast(payload("exited-1"));
    });
    await waitFor(() => reopenToasts().length === 1);
    // Let every pending mount and dismiss inside sonner settle.
    for (let i = 0; i < 10; i++) await tick();
    expect(reopenToasts()).toHaveLength(1);
    expect(reopenToasts()[0].textContent).toContain("Closed “exited-1”");
  });

  it("shows the coalesced toast while a keep-clear box still docks the stack", async () => {
    act(() => showReopenToast(payload("a")));
    await tick();
    act(() => showReopenToast(payload("b")));
    await tick();
    act(() => showReopenToast(payload("c")));
    await waitFor(() => (reopenToasts()[0]?.textContent ?? "").includes("Closed 3 tabs"));
    expect(document.documentElement.classList.contains("th-toast-docked")).toBe(true);
    expect(reopenToasts()).toHaveLength(1);
  });
});

/**
 * #5914: a dialog opening hides the reopen toast instead of dismissing it, and
 * a close made while it is hidden (a live session's confirm dialog) still joins
 * it. Once the dialog closes, one coalesced toast offers every closed tab.
 */
describe("reopen toast across a dialog (#5914)", () => {
  let dialog: HTMLDivElement | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    addTab.mockClear();
    resetReopenToastBatch();
    act(() => root.render(<ToastProvider />));
  });

  afterEach(() => {
    toast.dismiss();
    act(() => root.unmount());
    container.remove();
    dialog?.remove();
    dialog = null;
  });

  function openDialog() {
    dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.appendChild(dialog);
  }

  it("is hidden while the dialog is open and back, coalesced, after it closes", async () => {
    act(() => showReopenToast(payload("a")));
    await waitFor(() => reopenToasts().length === 1);

    await act(async () => openDialog());
    await waitFor(() => reopenToasts().length === 0);
    // A close made while the dialog is up (the confirm of a live session).
    act(() => showReopenToast(payload("b")));
    for (let i = 0; i < 5; i++) await tick();
    expect(reopenToasts()).toHaveLength(0);

    act(() => dialog!.remove());
    await waitFor(() => (reopenToasts()[0]?.textContent ?? "").includes("Closed 2 tabs"));
    for (let i = 0; i < 5; i++) await tick();
    expect(reopenToasts()).toHaveLength(1);

    const label = document.querySelector<HTMLElement>(
      `[data-testid="${REOPEN_TOAST_ACTION_TEST_ID}"]`
    );
    expect(label?.textContent).toBe("Reopen all");
    act(() => label!.click());
    expect(addTab.mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
  });
});
