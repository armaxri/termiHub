import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ConfirmDialog } from "./ConfirmDialog";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

describe("ConfirmDialog", () => {
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
    render(
      <ConfirmDialog open={false} title="T" message="M" onConfirm={vi.fn()} onCancel={vi.fn()} />
    );
    expect(document.querySelector('[data-testid="confirm-dialog-confirm"]')).toBeNull();
  });

  it("shows title, message, and custom labels", () => {
    render(
      <ConfirmDialog
        open
        title="Kill everything?"
        message="This stops 3 sessions."
        confirmLabel="Kill All"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        data-testid="my-confirm"
      />
    );
    const dialog = document.querySelector('[data-testid="my-confirm"]');
    expect(dialog?.textContent).toContain("Kill everything?");
    expect(dialog?.textContent).toContain("This stops 3 sessions.");
    expect(document.querySelector('[data-testid="confirm-dialog-confirm"]')?.textContent).toContain(
      "Kill All"
    );
  });

  it("fires onConfirm when the confirm button is clicked", () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog open title="T" message="M" onConfirm={onConfirm} onCancel={vi.fn()} />);
    act(() => {
      (document.querySelector('[data-testid="confirm-dialog-confirm"]') as HTMLElement).click();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("fires onCancel when the cancel button is clicked", () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog open title="T" message="M" onConfirm={vi.fn()} onCancel={onCancel} />);
    act(() => {
      (document.querySelector('[data-testid="confirm-dialog-cancel"]') as HTMLElement).click();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("renders the don't-ask-again toggle and reports changes", () => {
    const onChange = vi.fn();
    render(
      <ConfirmDialog
        open
        title="T"
        message="M"
        dontAskAgain={{ checked: false, onChange }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    const toggle = document.querySelector(
      '[data-testid="confirm-dialog-dont-ask-again"]'
    ) as HTMLElement;
    expect(toggle).toBeTruthy();
    act(() => toggle.click());
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
