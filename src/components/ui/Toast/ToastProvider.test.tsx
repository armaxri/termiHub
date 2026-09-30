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

/**
 * Emulate the browser's keyboard activation of a native `<button>` — jsdom does
 * not synthesize it. Per the HTML spec, Enter activates on keydown and Space on
 * keyup, each only when no handler cancelled the key event; activation is a
 * `click`. So this proves nothing in the toast swallows the key and that the
 * resulting activation dismisses, on an element that is a real, enabled button.
 */
function activateWithKey(el: HTMLButtonElement, key: string) {
  expect(el.tagName).toBe("BUTTON");
  expect(el.disabled).toBe(false);
  const init = { key, code: key === " " ? "Space" : key, bubbles: true, cancelable: true };
  const down = new KeyboardEvent("keydown", init);
  const downOk = el.dispatchEvent(down);
  if (key === "Enter") {
    if (downOk) el.click();
    return;
  }
  const upOk = el.dispatchEvent(new KeyboardEvent("keyup", init));
  if (downOk && upOk) el.click();
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

  it.each([
    ["success", () => toast.success("Intent success")],
    ["error", () => toast.error("Intent error")],
    ["info", () => toast.info("Intent info")],
  ])("renders the close button on a %s toast (#4013)", async (type, fire) => {
    render(<ToastProvider />);
    act(() => {
      fire();
    });
    await waitFor(
      () => document.querySelector(`[data-sonner-toast][data-type="${type}"]`) !== null
    );

    const toastEl = document.querySelector(`[data-sonner-toast][data-type="${type}"]`)!;
    const close = toastEl.querySelector("[data-close-button]");
    expect(close).not.toBeNull();
    expect(close?.getAttribute("aria-label")).toBe("Close");
    // The design-system lucide X, not sonner's built-in icon.
    expect(close?.querySelector("svg.th-toast__close-icon")).not.toBeNull();
  });

  it("renders no close button on a loading toast (#4013)", async () => {
    render(<ToastProvider />);
    act(() => {
      toast.loading("Deploying agent");
    });
    await waitFor(() => (document.body.textContent ?? "").includes("Deploying agent"));

    const toastEl = document.querySelector('[data-sonner-toast][data-type="loading"]');
    expect(toastEl).not.toBeNull();
    expect(toastEl?.querySelector("[data-close-button]")).toBeNull();
  });

  it.each([
    ["Enter", "Enter"],
    ["Space", " "],
  ])(
    "dismisses the toast when %s is pressed on the focused close button (#4013)",
    async (_name, key) => {
      render(<ToastProvider />);
      act(() => {
        // An error toast persists, so only the keypress can remove it.
        toast.error("Keyboard dismiss");
      });
      await waitFor(() => (document.body.textContent ?? "").includes("Keyboard dismiss"));

      const close = document.querySelector("[data-close-button]") as HTMLButtonElement;
      act(() => close.focus());
      expect(document.activeElement).toBe(close);

      act(() => {
        activateWithKey(close, key);
      });

      await waitFor(() => !(document.body.textContent ?? "").includes("Keyboard dismiss"));
      expect(document.body.textContent).not.toContain("Keyboard dismiss");
    }
  );
});
