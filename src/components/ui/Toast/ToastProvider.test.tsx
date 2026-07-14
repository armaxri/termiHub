import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ToastProvider } from "./ToastProvider";
import { toast } from "./toast";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

/** Advance a real macrotask tick inside act so sonner can flush its subscription. */
async function tick(ms = 25) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** Poll the DOM until `predicate` holds or the attempt budget is exhausted. */
async function waitFor(predicate: () => boolean, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error("waitFor: condition not met within budget");
}

describe("ToastProvider close button", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    toast.dismiss();
    act(() => root.unmount());
    container.remove();
  });

  it("renders a keyboard-accessible close button with a lucide icon on a toast", async () => {
    render(<ToastProvider />);
    act(() => {
      toast.success("Saved");
    });
    await waitFor(() => document.querySelector("[data-close-button]") !== null);

    const close = document.querySelector("[data-close-button]") as HTMLButtonElement;
    expect(close).toBeTruthy();
    // Native <button> is keyboard-focusable by default.
    expect(close.tagName).toBe("BUTTON");
    // Has an accessible name for screen-reader / keyboard users.
    expect(close.getAttribute("aria-label")).toBeTruthy();
    // Renders a real lucide SVG icon, not a unicode glyph.
    expect(close.querySelector("svg")).toBeTruthy();
    expect(close.textContent?.trim()).toBe("");
  });

  it("dismisses the toast immediately when the close button is clicked", async () => {
    render(<ToastProvider />);
    act(() => {
      toast.success("Dismiss me");
    });
    await waitFor(() => (document.body.textContent ?? "").includes("Dismiss me"));

    const close = document.querySelector("[data-close-button]") as HTMLButtonElement;
    act(() => close.click());

    await waitFor(() => !(document.body.textContent ?? "").includes("Dismiss me"));
    expect(document.body.textContent).not.toContain("Dismiss me");
  });
});
