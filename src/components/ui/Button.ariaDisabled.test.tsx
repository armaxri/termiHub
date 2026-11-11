/**
 * #5286: an `aria-disabled="true"` Button looks unavailable, like a `disabled` one.
 *
 * The connection and tunnel editors keep Save keyboard-reachable while the form
 * is invalid (`aria-disabled`, not `disabled` — activating it focuses the first
 * invalid field, #2467/#5285). Without a matching style the invalid Save looked
 * fully enabled.
 *
 * The dimming must not fade the focus ring: element `opacity` would also fade
 * the `:focus-visible` `--shadow-focus` ring (WCAG 2.4.11 / 1.4.11, ≥3:1). So
 * each variant's own colour tokens are mixed 50% toward transparent instead.
 * These checks load the real `ui.css` into the document and read computed
 * styles where jsdom can (opacity, cursor, pointer-events); `color-mix()` and
 * `:focus-visible` are beyond jsdom, so those parts are pinned on the CSS text.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { Button, type ButtonVariant } from "./Button";
import { contrastRatio } from "@/themes/contrast";
import { darkTheme } from "@/themes/dark";
import { lightTheme } from "@/themes/light";
import { solarizedDarkTheme } from "@/themes/solarized-dark";
import { solarizedLightTheme } from "@/themes/solarized-light";

const UI_CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ui.css"), "utf8");
const VARIANTS: ButtonVariant[] = ["primary", "secondary", "ghost", "danger"];
const ARIA_DISABLED = '[aria-disabled="true"]:not([disabled])';
/** WCAG 1.4.11 non-text contrast minimum for the focus indicator. */
const NON_TEXT_MIN_CONTRAST = 3;

let style: HTMLStyleElement;
let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement): HTMLButtonElement {
  act(() => {
    root.render(ui);
  });
  return container.querySelector("button") as HTMLButtonElement;
}

/** Escape a literal for use inside a RegExp. */
function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Declarations (`prop -> value`) of the single rule whose selector is exactly `selector`. */
function ruleDecls(selector: string): Map<string, string> {
  const m = UI_CSS.match(new RegExp(`(?:^|\\n)${escapeRe(selector)}\\s*\\{([^}]*)\\}`));
  expect(m, `rule ${selector}`).not.toBeNull();
  const decls = new Map<string, string>();
  for (const decl of (m as RegExpMatchArray)[1].split(";")) {
    const idx = decl.indexOf(":");
    if (idx < 0) continue;
    decls.set(decl.slice(0, idx).trim(), decl.slice(idx + 1).trim());
  }
  return decls;
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

  it("keeps the native disabled look unchanged", () => {
    const computed = getComputedStyle(render(<Button disabled>Save</Button>));
    expect({
      opacity: computed.opacity,
      cursor: computed.cursor,
      pointerEvents: computed.pointerEvents,
    }).toEqual({ opacity: "0.5", cursor: "not-allowed", pointerEvents: "none" });
  });

  it("gives an aria-disabled primary button the not-allowed cursor, still clickable", () => {
    const btn = render(<Button aria-disabled>Save</Button>);
    expect(btn.classList.contains("ui-btn--primary")).toBe(true);
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    expect(btn.disabled).toBe(false);
    const computed = getComputedStyle(btn);
    expect(computed.cursor).toBe("not-allowed");
    expect(computed.pointerEvents).not.toBe("none");
  });

  it("does not fade a focused aria-disabled button's focus ring", () => {
    const btn = render(<Button aria-disabled>Save</Button>);
    act(() => btn.focus());
    expect(document.activeElement).toBe(btn);
    // The ring is a box-shadow on the button itself, so the button (and every
    // ancestor) must stay fully opaque.
    for (let el: Element | null = btn; el; el = el.parentElement) {
      expect(["", "1"]).toContain(getComputedStyle(el).opacity);
    }
    expect(ruleDecls(".ui-btn:focus-visible").get("box-shadow")).toBe("var(--shadow-focus)");
    for (const variant of VARIANTS) {
      expect(ruleDecls(`.ui-btn--${variant}${ARIA_DISABLED}`).has("opacity")).toBe(false);
    }
    expect(ruleDecls(`.ui-btn${ARIA_DISABLED}`).has("opacity")).toBe(false);
  });

  it("leaves aria-disabled=false buttons at full strength", () => {
    const computed = getComputedStyle(render(<Button aria-disabled={false}>Save</Button>));
    expect(computed.opacity).not.toBe("0.5");
    expect(computed.cursor).toBe("pointer");
  });

  it.each(VARIANTS)(
    "dims every %s colour token to half strength while aria-disabled",
    (variant) => {
      const base = ruleDecls(`.ui-btn--${variant}`);
      const dimmed = ruleDecls(`.ui-btn--${variant}${ARIA_DISABLED}`);
      for (const prop of ["background", "color", "border-color"]) {
        const value = base.get(prop);
        if (!value || value === "transparent") {
          expect(dimmed.has(prop), `${prop} needs no dimming`).toBe(false);
          continue;
        }
        expect(dimmed.get(prop)).toBe(`color-mix(in srgb, ${value} 50%, transparent)`);
      }
    }
  );

  it.each(VARIANTS)("suppresses the %s hover highlight while aria-disabled", (variant) => {
    const hoverRules = [...UI_CSS.matchAll(new RegExp(`\\.ui-btn--${variant}:hover[^{]*\\{`, "g"))];
    expect(hoverRules.length).toBeGreaterThan(0);
    for (const [selector] of hoverRules) {
      expect(selector).toContain(':not([aria-disabled="true"])');
    }
  });

  it.each([darkTheme, lightTheme, solarizedDarkTheme, solarizedLightTheme])(
    "keeps the focus ring at ≥3:1 against the surface in the $id theme",
    (theme) => {
      // --shadow-focus = 2px --bg-primary gap + 2px --focus-border ring.
      const ratio = contrastRatio(theme.colors.focusBorder, theme.colors.bgPrimary);
      expect(ratio).toBeGreaterThanOrEqual(NON_TEXT_MIN_CONTRAST);
    }
  );
});
