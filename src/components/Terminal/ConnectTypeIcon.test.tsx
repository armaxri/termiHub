import type React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

/** Render into a detached container and return it (React 19 createRoot). */
function render(ui: React.ReactElement): { container: HTMLElement } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return { container };
}
import { ConnectTypeIcon } from "./ConnectTypeIcon";

/** The connect overlay's centre glyph uses the shared type map (#5622). */
afterEach(() => {
  document.body.innerHTML = "";
});

describe("ConnectTypeIcon", () => {
  it.each([
    ["ssh", "key-round"],
    ["vnc", "screen-share"],
    ["rdp", "monitor"],
    ["local", "terminal"],
    ["serial", "cable"],
  ])("renders the %s glyph", (type, expected) => {
    const { container } = render(<ConnectTypeIcon type={type} />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("data-icon")).toBe(expected);
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
  });
});
