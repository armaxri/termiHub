import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// Mock sonner so the tests see which toasts the wrapper dismisses.
const dismiss = vi.fn((_id?: unknown) => undefined);
vi.mock("sonner", () => ({
  toast: {
    loading: vi.fn(() => "loading-id"),
    success: vi.fn(() => undefined),
    error: vi.fn(() => undefined),
    info: vi.fn(() => undefined),
    dismiss: (id?: unknown) => dismiss(id),
  },
}));

import { dismissModalStaleToasts, toast } from "./toast";
import { useDismissOnModalOpen } from "./toastModal";

/** Ids sonner was asked to dismiss (each dismiss by id is issued twice, #4812). */
function dismissedIds(): unknown[] {
  return [...new Set(dismiss.mock.calls.map(([id]) => id))];
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

  beforeEach(() => {
    dismiss.mockClear();
    toast.dismiss();
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

  /** Let the MutationObserver deliver its records. */
  async function settle(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("dismisses a Closed / Reopen toast when a dialog opens", async () => {
    toast.success("Closed “web-1”", { id: "closed-1", dismissOnModal: true });
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.appendChild(dialog);
    await settle();
    expect(dismissedIds()).toEqual(["closed-1"]);
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
});
