import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// Mock sonner so the tests see which toasts the wrapper dismisses.
const dismiss = vi.fn((_id?: unknown) => undefined);
const success = vi.fn((_message: unknown, _opts?: unknown) => undefined);
vi.mock("sonner", () => ({
  toast: {
    loading: vi.fn(() => "loading-id"),
    success: (message: unknown, opts?: unknown) => success(message, opts),
    error: vi.fn(() => undefined),
    info: vi.fn(() => undefined),
    dismiss: (id?: unknown) => dismiss(id),
  },
}));

import { dismissModalStaleToasts, MIN_RESTORED_OFFER_MS, toast } from "./toast";
import { useDismissOnModalOpen } from "./toastModal";

/**
 * Toast ids sonner was asked to dismiss (each dismiss by id is issued twice,
 * #4812). A dismissed id is re-shown under `id~<n>` (#5904); that suffix is
 * dropped here.
 */
function dismissedIds(): unknown[] {
  return [...new Set(dismiss.mock.calls.map(([id]) => String(id).replace(/~\d+$/, "")))];
}

describe("dismissOnModal toasts (#5665)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    dismiss.mockClear();
    toast.dismiss();
    dismiss.mockClear();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("dismisses only the toasts raised with dismissOnModal", () => {
    toast.success("Closed “web-1”", { id: "closed-1", dismissOnModal: true });
    toast.success("Connected", { id: "connected-1" });
    toast.error("Boom", { id: "error-1" });
    dismissModalStaleToasts();
    expect(dismissedIds()).toEqual(["closed-1"]);
  });

  it("forgets a toast once it was dismissed or reused without the flag", () => {
    toast.success("Closed “a”", { id: "a", dismissOnModal: true });
    toast.success("Closed “b”", { id: "b", dismissOnModal: true });
    toast.dismiss("a");
    toast.success("Reused", { id: "b" });
    dismiss.mockClear();
    dismissModalStaleToasts();
    expect(dismiss).not.toHaveBeenCalled();
  });
});

function Probe() {
  useDismissOnModalOpen();
  return null;
}

describe("useDismissOnModalOpen (#5665)", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    toast.dismiss();
    // Let the repeat dismisses (#4812) an earlier test scheduled run out.
    await new Promise((resolve) => setTimeout(resolve, 0));
    dismiss.mockClear();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(React.createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  /** Open a modal dialog (any `aria-modal` element counts). */
  function openDialog(): HTMLElement {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.appendChild(dialog);
    return dialog;
  }

  /** Let the MutationObserver deliver its records. */
  async function settle(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("dismisses a toast raised with dismissOnModal when a dialog opens", async () => {
    toast.success("Closed “web-1”", { id: "closed-1", dismissOnModal: true });
    openDialog();
    await settle();
    expect(dismissedIds()).toEqual(["closed-1"]);
  });

  it("dismisses lingering success/info toasts when a dialog opens (#5830)", async () => {
    toast.success("Played macro", { id: "played" });
    toast.info("Disabled schedule", { id: "disabled" });
    toast.error("Sync failed", { id: "err" });
    const dialog = document.createElement("div");
    dialog.setAttribute("aria-modal", "true");
    document.body.appendChild(dialog);
    await settle();
    expect(dismissedIds().sort()).toEqual(["disabled", "played"]);
  });

  it("leaves the toast alone while no dialog opens", async () => {
    toast.success("Closed “web-1”", { id: "closed-1", dismissOnModal: true });
    document.body.appendChild(document.createElement("div"));
    await settle();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("does not dismiss a toast raised while a dialog was already open", async () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("aria-modal", "true");
    document.body.appendChild(dialog);
    await settle();
    toast.success("Closed “web-1”", { id: "closed-1", dismissOnModal: true });
    document.body.appendChild(document.createElement("p"));
    await settle();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("leaves an undo offer (a success with a button) out of the dismiss (#5914)", async () => {
    const undo = { label: "Undo", onClick: () => {} };
    toast.success("Deleted “prod”", { id: "undo", action: undo });
    toast.success("Played macro", { id: "played" });
    openDialog();
    await settle();
    // Taken off screen (so its id is dismissed), but still on offer.
    expect(toast.isActive("undo")).toBe(true);
    expect(toast.isActive("played")).toBe(false);
  });
});

/** The newest sonner.success call for the message `message`. */
function lastShown(message: string): { id?: unknown; duration?: number } | undefined {
  const calls = success.mock.calls.filter(([m]) => m === message);
  return calls[calls.length - 1]?.[1] as { id?: unknown; duration?: number } | undefined;
}

describe("undo offers survive a dialog (#5914)", () => {
  let host: HTMLDivElement;
  let root: Root;
  const undo = { label: "Undo", onClick: () => {} };

  beforeEach(async () => {
    toast.dismiss();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Only Date is faked: the clock the remaining lifetime is measured on.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-24T10:00:00Z"));
    dismiss.mockClear();
    success.mockClear();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(React.createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
    toast.dismiss();
    vi.useRealTimers();
  });

  function openDialog(): HTMLElement {
    const dialog = document.createElement("div");
    dialog.setAttribute("aria-modal", "true");
    document.body.appendChild(dialog);
    return dialog;
  }

  async function settle(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("hides the offer while a dialog is open and shows it again after", async () => {
    toast.success("Deleted “prod”", { id: "undo", action: undo, duration: 6000 });
    const dialog = openDialog();
    await settle();
    expect(dismissedIds()).toEqual(["undo"]);
    expect(success).toHaveBeenCalledTimes(1);
    expect(toast.isActive("undo")).toBe(true);

    dialog.remove();
    await settle();
    expect(success).toHaveBeenCalledTimes(2);
    expect(toast.isActive("undo")).toBe(true);
  });

  it("restores it with the lifetime it had left when the dialog opened", async () => {
    toast.success("Deleted “prod”", { id: "undo", action: undo, duration: 6000 });
    vi.advanceTimersByTime(2000);
    const dialog = openDialog();
    await settle();
    // Time spent in the dialog does not count against the offer.
    vi.advanceTimersByTime(60_000);
    dialog.remove();
    await settle();
    expect(lastShown("Deleted “prod”")?.duration).toBe(4000);
  });

  it("counts sonner's default lifetime for an offer without a duration", async () => {
    toast.success("Deleted “prod”", { id: "undo", action: undo });
    vi.advanceTimersByTime(1000);
    const dialog = openDialog();
    await settle();
    dialog.remove();
    await settle();
    expect(lastShown("Deleted “prod”")?.duration).toBe(3000);
  });

  it("gives an offer about to expire a short readable lifetime, not a flash", async () => {
    toast.success("Deleted “prod”", { id: "undo", action: undo, duration: 6000 });
    vi.advanceTimersByTime(5900);
    const dialog = openDialog();
    await settle();
    dialog.remove();
    await settle();
    expect(lastShown("Deleted “prod”")?.duration).toBe(MIN_RESTORED_OFFER_MS);
  });

  it("keeps a persistent offer persistent", async () => {
    toast.success("Deleted “prod”", { id: "undo", action: undo, duration: Infinity });
    vi.advanceTimersByTime(5000);
    const dialog = openDialog();
    await settle();
    dialog.remove();
    await settle();
    expect(lastShown("Deleted “prod”")?.duration).toBe(Infinity);
  });

  it("restores each offer only once its own dialog level closes (nested dialogs)", async () => {
    toast.success("Deleted “prod”", { id: "outer", action: undo });
    const first = openDialog();
    await settle();
    // An offer raised inside the first dialog shows beside it.
    toast.success("Removed key", { id: "inner", action: undo });
    expect(lastShown("Removed key")).toBeDefined();
    const second = openDialog();
    await settle();
    expect(toast.isActive("inner")).toBe(true);
    success.mockClear();

    second.remove();
    await settle();
    expect(success.mock.calls.map(([m]) => m)).toEqual(["Removed key"]);

    first.remove();
    await settle();
    expect(success.mock.calls.map(([m]) => m)).toEqual(["Removed key", "Deleted “prod”"]);
  });

  it("an offer updated while hidden stays hidden and shows its newest copy after", async () => {
    toast.success("Closed “a”", { id: "reopen", action: undo, duration: 6000 });
    const dialog = openDialog();
    await settle();
    success.mockClear();
    toast.success("Closed 2 tabs", { id: "reopen", action: undo, duration: 6000 });
    expect(success).not.toHaveBeenCalled();
    expect(toast.isActive("reopen")).toBe(true);

    dialog.remove();
    await settle();
    expect(success.mock.calls.map(([m]) => m)).toEqual(["Closed 2 tabs"]);
    expect(lastShown("Closed 2 tabs")?.duration).toBe(6000);
  });

  it("does not bring back an offer dismissed or replaced while hidden", async () => {
    toast.success("Deleted “a”", { id: "a", action: undo });
    toast.success("Deleted “b”", { id: "b", action: undo });
    toast.success("Deleted “c”", { id: "c", action: undo });
    const dialog = openDialog();
    await settle();
    toast.dismiss("a");
    toast.error("Undo failed", { id: "b" });
    toast.success("Saved", { id: "c" });
    expect(toast.isActive("a")).toBe(false);
    success.mockClear();

    dialog.remove();
    await settle();
    expect(success).not.toHaveBeenCalled();
  });

  it("keeps an offer with dismissOnModal dismissed for good", async () => {
    toast.success("Closed “a”", { id: "stale", action: undo, dismissOnModal: true });
    const dialog = openDialog();
    await settle();
    expect(toast.isActive("stale")).toBe(false);
    success.mockClear();
    dialog.remove();
    await settle();
    expect(success).not.toHaveBeenCalled();
  });
});
