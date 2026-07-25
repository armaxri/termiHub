import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { darkTheme, resolveTheme } from "@/themes";
import type { ThemeDefinition } from "@/themes/types";
import { ThemePreview } from "./ThemePreview";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

/** The hex strings shown in the preview, top to bottom. */
function hexValues(): string[] {
  return Array.from(container.querySelectorAll(".theme-preview__hex")).map(
    (el) => el.textContent ?? ""
  );
}

describe("ThemePreview", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("previews a built-in theme's four representative colors and its name", () => {
    render(<ThemePreview theme={resolveTheme("dark")} data-testid="preview" />);

    expect(container.querySelector('[data-testid="preview"]')).toBeTruthy();
    expect(container.querySelector(".theme-preview__name")?.textContent).toBe(darkTheme.name);
    // terminalBg / terminalFg / accentColor / bgPrimary, in that order.
    expect(hexValues()).toEqual([
      darkTheme.colors.terminalBg,
      darkTheme.colors.terminalFg,
      darkTheme.colors.accentColor,
      darkTheme.colors.bgPrimary,
    ]);
    // One color chip per representative color, filled with the theme's own value.
    const chips = Array.from(container.querySelectorAll<HTMLElement>(".theme-preview__chip"));
    expect(chips).toHaveLength(4);
    expect(chips[0].style.backgroundColor).not.toBe("");
  });

  it("previews a custom theme, falling back to its base for missing colors", () => {
    // A custom theme that overrides two colors and leaves the other two unset,
    // so resolution must fill the gaps from the base (dark) theme.
    const custom: ThemeDefinition = {
      id: "t1",
      name: "Ocean",
      colorScheme: "dark",
      baseTheme: "dark",
      colors: {
        terminalBg: "#001f3f",
        accentColor: "#39cccc",
      } as ThemeDefinition["colors"],
    };

    render(<ThemePreview theme={resolveTheme("custom:t1", [custom])} />);

    expect(container.querySelector(".theme-preview__name")?.textContent).toBe("Ocean");
    expect(hexValues()).toEqual([
      "#001f3f", // overridden terminalBg
      darkTheme.colors.terminalFg, // missing → base fallback
      "#39cccc", // overridden accentColor
      darkTheme.colors.bgPrimary, // missing → base fallback
    ]);
  });
});
