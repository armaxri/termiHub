/**
 * ConnectionIcon icon colour + emoji rendering (#5008): emoji replaces the
 * glyph, colour tints it with the theme-appropriate palette shade, and
 * invalid values fall back to the plain type icon.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConnectionIcon } from "./connectionIcons";
import { applyTheme } from "@/themes";
import { ICON_COLOR_PALETTE } from "./connectionIconStyle";
import type { ConnectionConfig } from "@/types/terminal";

const ssh: ConnectionConfig = { type: "ssh", config: { host: "h" } };
const blue = ICON_COLOR_PALETTE.find((e) => e.name === "blue")!;

let container: HTMLDivElement;
let root: Root;

function render(el: React.ReactElement) {
  act(() => root.render(el));
}

describe("ConnectionIcon colour and emoji", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    act(() => applyTheme("dark"));
  });

  it("renders the emoji instead of the glyph", () => {
    render(<ConnectionIcon config={ssh} iconEmoji="🚀" iconColor="blue" />);
    const emoji = container.querySelector('[data-testid="connection-icon-emoji"]');
    expect(emoji?.textContent).toBe("🚀");
    expect(container.querySelector("svg")).toBeNull();
  });

  it("ignores an invalid emoji and draws the type icon", () => {
    render(<ConnectionIcon config={ssh} iconEmoji="ab" />);
    expect(container.querySelector('[data-testid="connection-icon-emoji"]')).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("tints the glyph with the dark-theme shade, and switches live on theme change", () => {
    act(() => applyTheme("dark"));
    render(<ConnectionIcon config={ssh} iconColor="blue" />);
    expect(container.querySelector("svg")?.getAttribute("stroke")).toBe(blue.dark);

    act(() => applyTheme("light"));
    expect(container.querySelector("svg")?.getAttribute("stroke")).toBe(blue.light);
  });

  it("leaves the glyph untinted for an unknown colour", () => {
    render(<ConnectionIcon config={ssh} iconColor="url(javascript:x)" />);
    expect(container.querySelector("svg")?.getAttribute("stroke")).toBe("currentColor");
  });
});
