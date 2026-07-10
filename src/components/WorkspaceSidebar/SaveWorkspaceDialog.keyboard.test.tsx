/**
 * Keyboard-interaction test for SaveWorkspaceDialog (#1341): Enter submits from
 * any field via a wrapping <form>, honouring the empty-name guard.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { SaveWorkspaceDialog } from "./SaveWorkspaceDialog";

let container: HTMLDivElement;
let root: Root;

const baseProps = {
  tabGroupCount: 1,
  activeGroupName: "Group 1",
  onSave: () => {},
  onCancel: () => {},
};

function typeInto(testId: string, value: string) {
  const el = document.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)!;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function submitForm() {
  const form = document.querySelector<HTMLFormElement>('[data-testid="save-workspace-form"]')!;
  expect(form.tagName).toBe("FORM");
  act(() => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("SaveWorkspaceDialog — keyboard (#1341)", () => {
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

  it("submits on Enter (form submit) once a name is present", () => {
    const onSave = vi.fn();
    act(() => root.render(<SaveWorkspaceDialog {...baseProps} onSave={onSave} />));
    typeInto("save-workspace-name", "My Layout");
    submitForm();
    expect(onSave).toHaveBeenCalledWith("My Layout", "all", undefined);
  });

  it("does not submit on Enter when the name is empty", () => {
    const onSave = vi.fn();
    act(() => root.render(<SaveWorkspaceDialog {...baseProps} onSave={onSave} />));
    submitForm();
    expect(onSave).not.toHaveBeenCalled();
  });
});
