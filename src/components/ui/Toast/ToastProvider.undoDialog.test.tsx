/**
 * Undo offers survive a dialog opening (#5914), in the real toast host. Under
 * #5830 opening any dialog dismissed every success toast still showing, undo
 * offers ("Deleted … · Undo") included, so an unrelated dialog took the
 * recovery away. An offer is now hidden while the dialog is open and shown
 * again, with the lifetime it had left, once the dialog closes. Plain
 * confirmations still go for good (#5830).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ToastProvider } from "./ToastProvider";
import { toast } from "./toast";

let container: HTMLDivElement;
let root: Root;
let dialogs: HTMLElement[] = [];

async function tick(ms = 25) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function waitFor(predicate: () => boolean, attempts = 80) {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error("waitFor: condition not met within budget");
}

/** The toasts sonner renders that are not on their way out. */
function liveToasts(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-sonner-toast]")).filter(
    (el) => el.getAttribute("data-removed") !== "true"
  );
}

const shown = (text: string) => liveToasts().some((el) => (el.textContent ?? "").includes(text));

/** A small modal dialog (any `aria-modal` element counts). */
function openDialog(): HTMLElement {
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  document.body.appendChild(dialog);
  dialogs.push(dialog);
  return dialog;
}

describe("undo offers survive a dialog opening (#5914)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<ToastProvider />));
  });

  afterEach(() => {
    toast.dismiss();
    act(() => root.unmount());
    container.remove();
    for (const dialog of dialogs) dialog.remove();
    dialogs = [];
  });

  it("hides the offer while the dialog is open and brings it back, still clickable", async () => {
    const onUndo = vi.fn();
    act(() => {
      toast.success("Deleted folder “prod”", {
        id: "undo-delete",
        action: { label: "Undo", onClick: onUndo, testId: "undo-delete-action" },
      });
    });
    await waitFor(() => shown("Deleted folder “prod”"));

    const dialog = await act(async () => openDialog());
    await waitFor(() => !shown("Deleted folder “prod”"));
    // Let every pending mount and dismiss inside sonner settle.
    for (let i = 0; i < 5; i++) await tick();
    expect(shown("Deleted folder “prod”")).toBe(false);

    act(() => dialog.remove());
    await waitFor(() => shown("Deleted folder “prod”"));
    for (let i = 0; i < 5; i++) await tick();
    expect(shown("Deleted folder “prod”")).toBe(true);

    const label = document.querySelector<HTMLElement>('[data-testid="undo-delete-action"]');
    expect(label).not.toBeNull();
    act(() => label!.click());
    expect(onUndo).toHaveBeenCalledTimes(1);
    await waitFor(() => !shown("Deleted folder “prod”"));
  });

  it("time in the dialog does not use up the offer's lifetime", async () => {
    act(() => {
      toast.success("Deleted “k8s”", {
        id: "undo-short",
        duration: 600,
        action: { label: "Undo", onClick: () => {} },
      });
    });
    await waitFor(() => shown("Deleted “k8s”"));

    const dialog = await act(async () => openDialog());
    await waitFor(() => !shown("Deleted “k8s”"));
    // Stay in the dialog longer than the offer's whole lifetime.
    await tick(900);

    act(() => dialog.remove());
    await waitFor(() => shown("Deleted “k8s”"));
    expect(toast.isActive("undo-short")).toBe(true);
  });

  it("still dismisses a plain confirmation for good (#5830)", async () => {
    act(() => {
      toast.success("Connected", { id: "plain" });
      toast.success("Deleted “a”", { id: "undo-a", action: { label: "Undo", onClick: () => {} } });
    });
    await waitFor(() => shown("Connected") && shown("Deleted “a”"));

    const dialog = await act(async () => openDialog());
    await waitFor(() => !shown("Connected") && !shown("Deleted “a”"));

    act(() => dialog.remove());
    await waitFor(() => shown("Deleted “a”"));
    await tick(100);
    expect(shown("Connected")).toBe(false);
  });

  it("an offer raised inside a dialog shows beside it and stays after it closes", async () => {
    const dialog = await act(async () => openDialog());
    await tick();
    act(() => {
      toast.success("Removed key", { id: "undo-in", action: { label: "Undo", onClick: () => {} } });
    });
    await waitFor(() => shown("Removed key"));
    act(() => dialog.remove());
    await tick(100);
    expect(shown("Removed key")).toBe(true);
  });
});
