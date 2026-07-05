import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { SaveWorkspaceDialog } from "./SaveWorkspaceDialog";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

function typeInto(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const baseProps = {
  tabGroupCount: 1,
  activeGroupName: "Group 1",
  onSave: () => {},
  onCancel: () => {},
};

describe("SaveWorkspaceDialog", () => {
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

  it("renders through the Modal primitive with token'd inputs", () => {
    render(<SaveWorkspaceDialog {...baseProps} />);
    expect(document.querySelector(".ui-modal")).toBeTruthy();
    const name = document.querySelector('[data-testid="save-workspace-name"]') as HTMLInputElement;
    expect(name).toBeTruthy();
    expect(name.classList.contains("ui-input")).toBe(true);
  });

  it("Save is disabled until a name is entered, then fires onSave", () => {
    const onSave = vi.fn();
    render(<SaveWorkspaceDialog {...baseProps} onSave={onSave} />);

    const saveBtn = document.querySelector(
      '[data-testid="save-workspace-confirm"]'
    ) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);

    typeInto(
      document.querySelector('[data-testid="save-workspace-name"]') as HTMLInputElement,
      "  My Layout  "
    );
    typeInto(
      document.querySelector('[data-testid="save-workspace-description"]') as HTMLInputElement,
      "notes"
    );

    expect(saveBtn.disabled).toBe(false);
    act(() => saveBtn.click());
    expect(onSave).toHaveBeenCalledWith("My Layout", "all", "notes");
  });

  it("Cancel fires onCancel", () => {
    const onCancel = vi.fn();
    render(<SaveWorkspaceDialog {...baseProps} onCancel={onCancel} />);
    // The secondary footer button is Cancel.
    const buttons = Array.from(document.querySelectorAll(".ui-modal__foot button"));
    const cancel = buttons.find((b) => b.textContent === "Cancel") as HTMLButtonElement;
    act(() => cancel.click());
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows the scope selector when there is more than one tab group", () => {
    render(<SaveWorkspaceDialog {...baseProps} tabGroupCount={2} />);
    expect(document.querySelector('[data-testid="save-workspace-scope"]')).toBeTruthy();
  });
});
