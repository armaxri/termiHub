import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { RenameDialog } from "./RenameDialog";

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
  currentTitle: "old-name",
  onRename: () => {},
};

describe("RenameDialog", () => {
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
    render(<RenameDialog {...baseProps} open={false} />);
    expect(document.querySelector('[data-testid="rename-dialog-input"]')).toBeNull();
  });

  it("renders through the Modal primitive with the current title prefilled", () => {
    render(<RenameDialog {...baseProps} />);
    const modal = document.querySelector(".ui-modal");
    expect(modal).toBeTruthy();
    const input = document.querySelector('[data-testid="rename-dialog-input"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.classList.contains("ui-input")).toBe(true);
    expect(input.value).toBe("old-name");
  });

  it("Rename button fires onRename with the trimmed value and closes", () => {
    const onRename = vi.fn();
    const onOpenChange = vi.fn();
    render(<RenameDialog {...baseProps} onRename={onRename} onOpenChange={onOpenChange} />);

    const input = document.querySelector('[data-testid="rename-dialog-input"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )!.set!;
    act(() => {
      setter.call(input, "  new-name  ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    act(() => {
      (document.querySelector('[data-testid="rename-dialog-apply"]') as HTMLElement).click();
    });

    expect(onRename).toHaveBeenCalledWith("new-name");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Cancel button closes without renaming", () => {
    const onRename = vi.fn();
    const onOpenChange = vi.fn();
    render(<RenameDialog {...baseProps} onRename={onRename} onOpenChange={onOpenChange} />);
    act(() => {
      (document.querySelector('[data-testid="rename-dialog-cancel"]') as HTMLElement).click();
    });
    expect(onRename).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
