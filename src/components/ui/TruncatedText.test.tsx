/**
 * TruncatedText (#4709): an ellipsized label explains itself with the full text
 * in a tooltip — but only when it is actually clipped.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TruncatedText } from "./TruncatedText";
import { withTooltip } from "@/test/tooltip";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderText(): HTMLSpanElement {
  act(() =>
    root.render(
      withTooltip(<TruncatedText data-testid="txt">a-very-long-workspace-name</TruncatedText>)
    )
  );
  return container.querySelector('[data-testid="txt"]') as HTMLSpanElement;
}

/** Give the span a fake layout: `scroll` px of content in a `client` px box. */
function setLayout(el: HTMLElement, scroll: number, client: number) {
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: scroll });
  Object.defineProperty(el, "clientWidth", { configurable: true, value: client });
}

function hover(el: HTMLElement) {
  act(() => {
    // React derives onPointerEnter from a bubbling pointerover.
    el.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
  });
  act(() => {
    el.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
  });
}

function tooltipText(): string | null {
  return document.querySelector('[role="tooltip"]')?.textContent ?? null;
}

describe("TruncatedText", () => {
  it("renders the full text in the DOM with the truncation class", () => {
    const el = renderText();
    expect(el.textContent).toBe("a-very-long-workspace-name");
    expect(el.classList.contains("ui-truncate")).toBe(true);
  });

  it("shows no tooltip when the text fits", () => {
    const el = renderText();
    setLayout(el, 100, 100);
    hover(el);
    expect(tooltipText()).toBeNull();
  });

  it("shows the full text in a tooltip when the text is clipped", () => {
    let el = renderText();
    setLayout(el, 300, 80);
    hover(el);
    // The tooltip root mounts on the first clipped hover; re-query the span.
    el = container.querySelector('[data-testid="txt"]') as HTMLSpanElement;
    setLayout(el, 300, 80);
    act(() => {
      el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    expect(tooltipText()).toContain("a-very-long-workspace-name");
  });
});
