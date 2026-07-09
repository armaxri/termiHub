import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ColorPickerDialog } from "./ColorPickerDialog";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

const baseProps = {
  open: true,
  onOpenChange: () => {},
  currentColor: "#3b82f6",
  onColorChange: () => {},
};

describe("ColorPickerDialog", () => {
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

  it("renders nothing when closed", () => {
    render(<ColorPickerDialog {...baseProps} open={false} />);
    expect(document.querySelector('[data-testid="color-picker-apply"]')).toBeNull();
  });

  it("renders through the Modal primitive with preset swatches and hex input", () => {
    render(<ColorPickerDialog {...baseProps} />);
    expect(document.querySelector(".ui-modal")).toBeTruthy();
    expect(document.querySelector('[data-testid="color-picker-swatch-3b82f6"]')).toBeTruthy();
    const hex = document.querySelector(
      '[data-testid="color-picker-hex-input"]'
    ) as HTMLInputElement;
    expect(hex).toBeTruthy();
    expect(hex.classList.contains("ui-input")).toBe(true);
  });

  it("Apply fires onColorChange with the selected swatch and closes", () => {
    const onColorChange = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ColorPickerDialog {...baseProps} onColorChange={onColorChange} onOpenChange={onOpenChange} />
    );

    act(() => {
      (document.querySelector('[data-testid="color-picker-swatch-22c55e"]') as HTMLElement).click();
    });
    act(() => {
      (document.querySelector('[data-testid="color-picker-apply"]') as HTMLElement).click();
    });

    expect(onColorChange).toHaveBeenCalledWith("#22c55e");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Clear fires onColorChange with null and closes", () => {
    const onColorChange = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ColorPickerDialog {...baseProps} onColorChange={onColorChange} onOpenChange={onOpenChange} />
    );
    act(() => {
      (document.querySelector('[data-testid="color-picker-clear"]') as HTMLElement).click();
    });
    expect(onColorChange).toHaveBeenCalledWith(null);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
