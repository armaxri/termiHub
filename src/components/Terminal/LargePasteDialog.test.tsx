import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { LargePasteDialog } from "./LargePasteDialog";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

const baseProps = {
  open: true,
  charCount: 12345,
  onConfirm: () => {},
  onCancel: () => {},
};

describe("LargePasteDialog", () => {
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
    render(<LargePasteDialog {...baseProps} open={false} />);
    expect(document.querySelector('[data-testid="large-paste-dialog"]')).toBeNull();
  });

  it("renders through the Modal primitive and shows the formatted char count", () => {
    render(<LargePasteDialog {...baseProps} />);
    const dialog = document.querySelector('[data-testid="large-paste-dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog!.classList.contains("ui-modal")).toBe(true);
    expect(dialog!.textContent).toContain("12,345");
  });

  it("Paste button fires onConfirm", () => {
    const onConfirm = vi.fn();
    render(<LargePasteDialog {...baseProps} onConfirm={onConfirm} />);
    act(() => {
      (document.querySelector('[data-testid="large-paste-confirm"]') as HTMLElement).click();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("Cancel button fires onCancel", () => {
    const onCancel = vi.fn();
    render(<LargePasteDialog {...baseProps} onCancel={onCancel} />);
    act(() => {
      (document.querySelector('[data-testid="large-paste-cancel"]') as HTMLElement).click();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
