/**
 * The shared unsaved-changes dialog (UISF2-005, #4314). It is reused by the
 * connection editor, the file editor, the tunnel and workspace editors and the
 * Modal dismiss guard, so its copy follows a `subject` instead of always saying
 * "connection", and it is announced once (description only, never twice).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { UnsavedChangesDialog } from "./Modal";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

const baseProps = {
  open: true,
  subject: "connection" as const,
  onCancel: () => {},
  onJustClose: () => {},
  onSaveAndClose: () => {},
};

const q = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

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
    expect(q("unsaved-changes-cancel")).toBeTruthy();
    expect(q("unsaved-changes-just-close")).toBeTruthy();
    expect(q("unsaved-changes-save-and-close")).toBeTruthy();
  });

  it("Save & Close fires onSaveAndClose", () => {
    const onSaveAndClose = vi.fn();
    render(<UnsavedChangesDialog {...baseProps} onSaveAndClose={onSaveAndClose} />);
    act(() => q("unsaved-changes-save-and-close")!.click());
    expect(onSaveAndClose).toHaveBeenCalledTimes(1);
  });

  it("Just Close (danger) fires onJustClose", () => {
    const onJustClose = vi.fn();
    render(<UnsavedChangesDialog {...baseProps} onJustClose={onJustClose} />);
    const btn = q("unsaved-changes-just-close") as HTMLButtonElement;
    expect(btn.classList.contains("ui-btn--danger")).toBe(true);
    act(() => btn.click());
    expect(onJustClose).toHaveBeenCalledTimes(1);
  });

  it("Cancel fires onCancel", () => {
    const onCancel = vi.fn();
    render(<UnsavedChangesDialog {...baseProps} onCancel={onCancel} />);
    act(() => q("unsaved-changes-cancel")!.click());
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  describe("copy follows the subject (UISF2-005)", () => {
    it("says connection for a connection editor", () => {
      render(<UnsavedChangesDialog {...baseProps} subject="connection" />);
      expect(q("unsaved-changes-message")!.textContent).toContain("This connection has unsaved");
    });

    it("says file for a file editor, never connection", () => {
      render(<UnsavedChangesDialog {...baseProps} subject="file" />);
      const text = document.querySelector(".ui-modal")!.textContent ?? "";
      expect(text).toContain("This file has unsaved changes");
      expect(text).not.toContain("connection");
    });

    it("names the item when a name is given", () => {
      render(<UnsavedChangesDialog {...baseProps} subject="file" name="nginx.conf" />);
      expect(q("unsaved-changes-message")!.textContent).toContain("“nginx.conf”");
    });

    it("announces the message once: the visible copy is hidden from assistive tech", () => {
      render(<UnsavedChangesDialog {...baseProps} subject="file" />);
      const dialog = document.querySelector(".ui-modal")!;
      const describedBy = dialog.getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();
      expect(document.getElementById(describedBy!)!.textContent).toContain("This file has");
      expect(q("unsaved-changes-message")!.getAttribute("aria-hidden")).toBe("true");
    });
  });

  it("offers only Cancel and Discard when there is no save path", () => {
    render(
      <UnsavedChangesDialog
        open
        subject="form"
        onCancel={() => {}}
        onJustClose={() => {}}
        onSaveAndClose={undefined}
      />
    );
    expect(q("unsaved-changes-save-and-close")).toBeNull();
    expect(q("unsaved-changes-just-close")!.textContent).toContain("Discard");
    expect(q("unsaved-changes-message")!.textContent).toContain("You have unsaved changes");
  });
});
