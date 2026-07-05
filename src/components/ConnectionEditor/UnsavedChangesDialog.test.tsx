import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { UnsavedChangesDialog } from "./UnsavedChangesDialog";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

const baseProps = {
  open: true,
  onCancel: () => {},
  onJustClose: () => {},
  onSaveAndClose: () => {},
};

describe("UnsavedChangesDialog", () => {
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
    render(<UnsavedChangesDialog {...baseProps} open={false} />);
    expect(document.querySelector(".ui-modal")).toBeNull();
  });

  it("renders through the Modal primitive with the three actions", () => {
    render(<UnsavedChangesDialog {...baseProps} />);
    expect(document.querySelector(".ui-modal")).toBeTruthy();
    expect(document.querySelector('[data-testid="unsaved-changes-cancel"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="unsaved-changes-just-close"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="unsaved-changes-save-and-close"]')).toBeTruthy();
  });

  it("Save & Close fires onSaveAndClose", () => {
    const onSaveAndClose = vi.fn();
    render(<UnsavedChangesDialog {...baseProps} onSaveAndClose={onSaveAndClose} />);
    act(() => {
      (
        document.querySelector('[data-testid="unsaved-changes-save-and-close"]') as HTMLElement
      ).click();
    });
    expect(onSaveAndClose).toHaveBeenCalledTimes(1);
  });

  it("Just Close (danger) fires onJustClose", () => {
    const onJustClose = vi.fn();
    render(<UnsavedChangesDialog {...baseProps} onJustClose={onJustClose} />);
    const btn = document.querySelector(
      '[data-testid="unsaved-changes-just-close"]'
    ) as HTMLButtonElement;
    expect(btn.classList.contains("ui-btn--danger")).toBe(true);
    act(() => btn.click());
    expect(onJustClose).toHaveBeenCalledTimes(1);
  });

  it("Cancel fires onCancel", () => {
    const onCancel = vi.fn();
    render(<UnsavedChangesDialog {...baseProps} onCancel={onCancel} />);
    act(() => {
      (document.querySelector('[data-testid="unsaved-changes-cancel"]') as HTMLElement).click();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
