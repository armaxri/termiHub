import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { OpenSavedFileDialog } from "./OpenSavedFileDialog";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

const baseProps = {
  open: true,
  filePath: "/home/user/terminal-output.txt",
  askAgain: true,
  onAskAgainChange: () => {},
  onOpen: () => {},
  onCancel: () => {},
};

describe("OpenSavedFileDialog", () => {
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
    render(<OpenSavedFileDialog {...baseProps} open={false} />);
    expect(document.querySelector('[data-testid="open-saved-file-dialog"]')).toBeNull();
  });

  it("shows the saved file name in the description", () => {
    render(<OpenSavedFileDialog {...baseProps} />);
    const dialog = document.querySelector('[data-testid="open-saved-file-dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog?.textContent).toContain("terminal-output.txt");
  });

  it("reflects askAgain in the checkbox", () => {
    render(<OpenSavedFileDialog {...baseProps} askAgain={false} />);
    const checkbox = document.querySelector(
      '[data-testid="open-saved-file-ask-again"]'
    ) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
  });

  it("toggling the checkbox fires onAskAgainChange with the new value", () => {
    const onAskAgainChange = vi.fn();
    render(
      <OpenSavedFileDialog {...baseProps} askAgain={true} onAskAgainChange={onAskAgainChange} />
    );
    act(() => {
      (document.querySelector('[data-testid="open-saved-file-ask-again"]') as HTMLElement).click();
    });
    expect(onAskAgainChange).toHaveBeenCalledWith(false);
  });

  it("Open button fires onOpen", () => {
    const onOpen = vi.fn();
    render(<OpenSavedFileDialog {...baseProps} onOpen={onOpen} />);
    act(() => {
      (document.querySelector('[data-testid="open-saved-file-confirm"]') as HTMLElement).click();
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("Cancel button fires onCancel", () => {
    const onCancel = vi.fn();
    render(<OpenSavedFileDialog {...baseProps} onCancel={onCancel} />);
    act(() => {
      (document.querySelector('[data-testid="open-saved-file-cancel"]') as HTMLElement).click();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
