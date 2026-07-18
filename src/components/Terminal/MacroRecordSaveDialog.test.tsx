import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { MacroRecordSaveDialog } from "./MacroRecordSaveDialog";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

function setInput(testid: string, value: string) {
  const input = document.querySelector(`[data-testid="${testid}"]`) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const baseProps = {
  open: true,
  stepCount: 3,
  onSave: () => {},
  onCancel: () => {},
};

describe("MacroRecordSaveDialog", () => {
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
    render(<MacroRecordSaveDialog {...baseProps} open={false} />);
    expect(document.querySelector('[data-testid="macro-save-name"]')).toBeNull();
  });

  it("renders through the Modal primitive and shows the captured step count", () => {
    render(<MacroRecordSaveDialog {...baseProps} stepCount={5} />);
    expect(document.querySelector(".ui-modal")).toBeTruthy();
    expect(document.querySelector('[data-testid="macro-save-name"]')).toBeTruthy();
    expect(document.body.textContent).toContain("5");
  });

  it("disables Save until a name is entered", () => {
    render(<MacroRecordSaveDialog {...baseProps} />);
    const save = document.querySelector('[data-testid="macro-save-confirm"]') as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    setInput("macro-save-name", "Deploy");
    expect(save.disabled).toBe(false);
  });

  it("Save fires onSave with trimmed name, description, and parsed tags", () => {
    const onSave = vi.fn();
    render(<MacroRecordSaveDialog {...baseProps} onSave={onSave} />);

    setInput("macro-save-name", "  Deploy  ");
    setInput("macro-save-description", "prod release");
    setInput("macro-save-tags", "ops, release ,, prod");

    act(() => {
      (document.querySelector('[data-testid="macro-save-confirm"]') as HTMLElement).click();
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({
      name: "Deploy",
      description: "prod release",
      tags: ["ops", "release", "prod"],
    });
  });

  it("omits an empty description", () => {
    const onSave = vi.fn();
    render(<MacroRecordSaveDialog {...baseProps} onSave={onSave} />);
    setInput("macro-save-name", "Bare");
    act(() => {
      (document.querySelector('[data-testid="macro-save-confirm"]') as HTMLElement).click();
    });
    expect(onSave).toHaveBeenCalledWith({ name: "Bare", description: undefined, tags: [] });
  });

  it("Cancel fires onCancel without saving", () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    render(<MacroRecordSaveDialog {...baseProps} onSave={onSave} onCancel={onCancel} />);
    act(() => {
      (document.querySelector('[data-testid="macro-save-cancel"]') as HTMLElement).click();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });
});
