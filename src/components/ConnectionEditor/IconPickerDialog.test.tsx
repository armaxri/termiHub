import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { IconPickerDialog } from "./IconPickerDialog";

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
  currentIcon: undefined,
  onIconChange: () => {},
};

describe("IconPickerDialog", () => {
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
    render(<IconPickerDialog {...baseProps} open={false} />);
    expect(document.querySelector('[data-testid="icon-picker-search"]')).toBeNull();
  });

  it("renders through the Modal primitive with a token'd search Input and grid", () => {
    render(<IconPickerDialog {...baseProps} />);
    expect(document.querySelector(".ui-modal")).toBeTruthy();
    const search = document.querySelector('[data-testid="icon-picker-search"]') as HTMLInputElement;
    expect(search).toBeTruthy();
    expect(search.classList.contains("ui-input")).toBe(true);
    expect(document.querySelector('[data-testid="icon-picker-grid"]')).toBeTruthy();
  });

  it("Apply fires onIconChange with the selected icon and closes", () => {
    const onIconChange = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <IconPickerDialog
        {...baseProps}
        currentIcon="server"
        onIconChange={onIconChange}
        onOpenChange={onOpenChange}
      />
    );
    act(() => {
      (document.querySelector('[data-testid="icon-picker-apply"]') as HTMLElement).click();
    });
    expect(onIconChange).toHaveBeenCalledWith("server");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Clear fires onIconChange with null and closes", () => {
    const onIconChange = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <IconPickerDialog
        {...baseProps}
        currentIcon="server"
        onIconChange={onIconChange}
        onOpenChange={onOpenChange}
      />
    );
    act(() => {
      (document.querySelector('[data-testid="icon-picker-clear"]') as HTMLElement).click();
    });
    expect(onIconChange).toHaveBeenCalledWith(null);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
