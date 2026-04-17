import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

describe("ConfirmDeleteDialog", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it("renders with the provided message when open", () => {
    render(
      <ConfirmDeleteDialog
        open={true}
        message='Delete file "notes.txt"?'
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    const dialog = document.querySelector('[data-testid="confirm-delete-dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog?.textContent).toContain('Delete file "notes.txt"?');
  });

  it("does not render content when closed", () => {
    render(
      <ConfirmDeleteDialog
        open={false}
        message="Delete 3 items?"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(document.querySelector('[data-testid="confirm-delete-dialog"]')).toBeNull();
  });

  it("calls onConfirm when Delete button is clicked", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDeleteDialog
        open={true}
        message='Delete file "test.txt"?'
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />
    );

    act(() => {
      (document.querySelector('[data-testid="confirm-delete-confirm"]') as HTMLElement).click();
    });

    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("calls onCancel when Cancel button is clicked", () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDeleteDialog
        open={true}
        message='Delete directory "mydir"?'
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />
    );

    act(() => {
      (document.querySelector('[data-testid="confirm-delete-cancel"]') as HTMLElement).click();
    });

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("shows multi-item delete message", () => {
    render(
      <ConfirmDeleteDialog
        open={true}
        message="Delete 5 items?"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(document.querySelector('[data-testid="confirm-delete-dialog"]')?.textContent).toContain(
      "Delete 5 items?"
    );
  });
});
