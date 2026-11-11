/**
 * #5286: an `aria-disabled="true"` Button looks exactly like a `disabled` one.
 *
 * The connection and tunnel editors keep Save keyboard-reachable while the form
 * is invalid (`aria-disabled`, not `disabled` — activating it focuses the first
 * invalid field, #2467/#5285). Without a matching style the invalid Save looked
 * fully enabled. These checks load the real `ui.css` into the document and read
 * the computed style, and pin that the variant hover highlight excludes it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { Button, type ButtonVariant } from "./Button";

const UI_CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ui.css"), "utf8");
const VARIANTS: ButtonVariant[] = ["primary", "secondary", "ghost", "danger"];

let style: HTMLStyleElement;
let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement): HTMLButtonElement {
  act(() => {
    root.render(ui);
  });
  return container.querySelector("button") as HTMLButtonElement;
}

describe("Button aria-disabled look (#5286)", () => {
  beforeAll(() => {
    style = document.createElement("style");
    style.textContent = UI_CSS;
    document.head.appendChild(style);
  });

  afterAll(() => style.remove());

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("gives an aria-disabled primary button the same dimmed look as a disabled one", () => {
    const disabled = getComputedStyle(render(<Button disabled>Save</Button>));
    const disabledLook = { opacity: disabled.opacity, cursor: disabled.cursor };
    expect(disabledLook).toEqual({ opacity: "0.5", cursor: "not-allowed" });

    const btn = render(<Button aria-disabled>Save</Button>);
    expect(btn.classList.contains("ui-btn--primary")).toBe(true);
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    const computed = getComputedStyle(btn);
    expect({ opacity: computed.opacity, cursor: computed.cursor }).toEqual(disabledLook);
  });

  it("keeps an aria-disabled button focusable and clickable", () => {
    const btn = render(<Button aria-disabled>Save</Button>);
    expect(btn.disabled).toBe(false);
    expect(getComputedStyle(btn).pointerEvents).not.toBe("none");
    act(() => btn.focus());
    expect(document.activeElement).toBe(btn);
  });

  it("leaves aria-disabled=false buttons at full strength", () => {
    const computed = getComputedStyle(render(<Button aria-disabled={false}>Save</Button>));
    expect(computed.opacity).not.toBe("0.5");
    expect(computed.cursor).toBe("pointer");
  });

  it.each(VARIANTS)("suppresses the %s hover highlight while aria-disabled", (variant) => {
    const hoverRules = [...UI_CSS.matchAll(new RegExp(`\\.ui-btn--${variant}:hover[^{]*\\{`, "g"))];
    expect(hoverRules.length).toBeGreaterThan(0);
    for (const [selector] of hoverRules) {
      expect(selector).toContain(':not([aria-disabled="true"])');
    }
  });
});
