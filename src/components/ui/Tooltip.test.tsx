import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Tooltip, TooltipProvider } from "./Tooltip";

// jsdom lacks the observers/pointer-capture APIs Radix Tooltip touches when it
// measures and portals its content; shim them so the primitive can mount.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
    ResizeObserverStub;
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

/** Wrap in a zero-delay provider so hover reveals the tooltip synchronously. */
function withProvider(ui: React.ReactElement): React.ReactElement {
  return <TooltipProvider delayDuration={0}>{ui}</TooltipProvider>;
}

describe("Tooltip", () => {
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

  it("renders the trigger child and keeps it focusable", () => {
    render(
      withProvider(
        <Tooltip content="Connections">
          <button data-testid="trigger" aria-label="Connections">
            icon
          </button>
        </Tooltip>
      )
    );
    const trigger = document.querySelector('[data-testid="trigger"]') as HTMLButtonElement;
    expect(trigger).toBeTruthy();
    expect(trigger.tagName).toBe("BUTTON");
    // Trigger is reachable without an injected tabindex removing it from tab order.
    expect(trigger.getAttribute("tabindex")).not.toBe("-1");
    act(() => trigger.focus());
    expect(document.activeElement).toBe(trigger);
  });

  it("shows the content on focus and forwards data-testid to the content", () => {
    render(
      withProvider(
        <Tooltip content="Settings" data-testid="tt-content">
          <button aria-label="Settings">icon</button>
        </Tooltip>
      )
    );
    const trigger = document.querySelector("button") as HTMLButtonElement;
    act(() => {
      trigger.focus();
      trigger.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
    });
    const content = document.querySelector('[data-testid="tt-content"]');
    expect(content).toBeTruthy();
    expect(content?.textContent).toContain("Settings");
    expect(content?.classList.contains("ui-tooltip__content")).toBe(true);
  });

  it("shows the content on pointer hover after the group delay", () => {
    // Radix opens hover-triggered tooltips through the provider's delay timer,
    // so drive it with fake timers rather than relying on wall-clock timing.
    vi.useFakeTimers();
    try {
      render(
        withProvider(
          <Tooltip content="Log Viewer" data-testid="tt-content">
            <button aria-label="Log Viewer">icon</button>
          </Tooltip>
        )
      );
      const trigger = document.querySelector("button") as HTMLButtonElement;
      act(() => {
        trigger.dispatchEvent(
          new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" })
        );
      });
      act(() => {
        vi.runOnlyPendingTimers();
      });
      const content = document.querySelector('[data-testid="tt-content"]');
      expect(content?.textContent).toContain("Log Viewer");
    } finally {
      vi.useRealTimers();
    }
  });

  it("wires the trigger to its tooltip via aria-describedby when open", () => {
    render(
      withProvider(
        <Tooltip content="Connections">
          <button aria-label="Connections">icon</button>
        </Tooltip>
      )
    );
    const trigger = document.querySelector("button") as HTMLButtonElement;
    act(() => {
      trigger.focus();
      trigger.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
    });
    // Radix associates the visible tooltip with its trigger for screen readers.
    expect(trigger.getAttribute("aria-describedby")).toBeTruthy();
  });
});
