/**
 * Tests for the shared editor keyboard handler (#1341): Enter submits from a
 * single-line text input, Escape cancels, multi-line/list/non-text fields are
 * exempt, and an invalid form (canSubmit=false) does not submit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useEditorKeyboard, type EditorKeyboardOptions } from "./useEditorKeyboard";

function Harness(opts: EditorKeyboardOptions) {
  const onKeyDown = useEditorKeyboard(opts);
  return (
    <div data-testid="root" onKeyDown={onKeyDown}>
      <input data-testid="text" type="text" />
      <input data-testid="checkbox" type="checkbox" />
      <textarea data-testid="textarea" />
      <div data-testid="list" className="exempt-zone">
        <input data-testid="list-input" type="text" />
      </div>
    </div>
  );
}

let container: HTMLDivElement;
let root: Root;

function render(opts: EditorKeyboardOptions) {
  act(() => {
    root.render(<Harness {...opts} />);
  });
}

function press(testId: string, key: string): boolean {
  const el = container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!;
  const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  act(() => {
    el.dispatchEvent(ev);
  });
  return ev.defaultPrevented;
}

describe("useEditorKeyboard (#1341)", () => {
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

  it("Enter from a text input submits", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render({ onSubmit, onCancel });
    const prevented = press("text", "Enter");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    expect(prevented).toBe(true);
  });

  it("Escape cancels from anywhere", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render({ onSubmit, onCancel });
    press("textarea", "Escape");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Enter in a textarea does not submit (multi-line exempt)", () => {
    const onSubmit = vi.fn();
    render({ onSubmit, onCancel: vi.fn() });
    press("textarea", "Enter");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Enter on a checkbox does not submit (non-text input)", () => {
    const onSubmit = vi.fn();
    render({ onSubmit, onCancel: vi.fn() });
    press("checkbox", "Enter");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Enter inside an exempt container does not submit (list exempt)", () => {
    const onSubmit = vi.fn();
    render({ onSubmit, onCancel: vi.fn(), exemptSelector: ".exempt-zone" });
    press("list-input", "Enter");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Enter does not submit when canSubmit is false", () => {
    const onSubmit = vi.fn();
    render({ onSubmit, onCancel: vi.fn(), canSubmit: false });
    const prevented = press("text", "Enter");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(prevented).toBe(false);
  });
});
