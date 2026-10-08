import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Chip } from "./Chip";
import { TooltipProvider } from "./Tooltip";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(<TooltipProvider>{ui}</TooltipProvider>);
  });
}

describe("Chip", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders its label and icon", () => {
    render(<Chip label="Own data folder" icon={<svg data-testid="icon" />} data-testid="chip" />);
    const chip = container.querySelector('[data-testid="chip"]')!;
    expect(chip.textContent).toBe("Own data folder");
    expect(chip.classList.contains("ui-chip--denied")).toBe(false);
    expect(chip.querySelector('[data-testid="icon"]')).not.toBeNull();
    expect(chip.getAttribute("tabindex")).toBeNull();
  });

  it("marks a denied chip visually and for assistive technology", () => {
    render(<Chip label="Run programs" denied data-testid="chip" />);
    const chip = container.querySelector('[data-testid="chip"]')!;
    expect(chip.classList.contains("ui-chip--denied")).toBe(true);
    expect(chip.getAttribute("aria-label")).toBe("Run programs (not allowed)");
  });

  it("is focusable when it carries a tooltip", () => {
    render(<Chip label="Network via termiHub" tooltip="max 8 connections" data-testid="chip" />);
    expect(container.querySelector('[data-testid="chip"]')!.getAttribute("tabindex")).toBe("0");
  });
});
