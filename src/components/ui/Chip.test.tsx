import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Chip } from "./Chip";
import { TooltipProvider } from "./Tooltip";
import { checkA11y } from "@/test/axe";

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

  it("is a read-only span without onPressedChange", () => {
    render(<Chip label="Static" data-testid="chip" />);
    const chip = container.querySelector('[data-testid="chip"]')!;
    expect(chip.tagName).toBe("SPAN");
    expect(chip.hasAttribute("aria-pressed")).toBe(false);
  });

  it("becomes an aria-pressed toggle button with onPressedChange", () => {
    const onPressedChange = vi.fn();
    render(
      <Chip label="Manual" pressed={false} onPressedChange={onPressedChange} data-testid="chip" />
    );
    const chip = container.querySelector('[data-testid="chip"]') as HTMLButtonElement;
    expect(chip.tagName).toBe("BUTTON");
    expect(chip.getAttribute("type")).toBe("button");
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    expect(chip.classList.contains("ui-chip--pressed")).toBe(false);
    act(() => chip.click());
    expect(onPressedChange).toHaveBeenCalledWith(true);
  });

  it("reflects the pressed state and toggles off", () => {
    const onPressedChange = vi.fn();
    render(<Chip label="Manual" pressed onPressedChange={onPressedChange} data-testid="chip" />);
    const chip = container.querySelector('[data-testid="chip"]') as HTMLButtonElement;
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(chip.classList.contains("ui-chip--pressed")).toBe(true);
    act(() => chip.click());
    expect(onPressedChange).toHaveBeenCalledWith(false);
  });

  it("toggle chip has no a11y violations", async () => {
    render(<Chip label="Hotkey" pressed onPressedChange={() => {}} />);
    expect(await checkA11y()).toHaveNoViolations();
  });
});
