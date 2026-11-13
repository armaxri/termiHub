import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ConnectTypeIcon } from "./ConnectTypeIcon";

/** The connect overlay's centre glyph uses the shared type map (#5622). */
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
