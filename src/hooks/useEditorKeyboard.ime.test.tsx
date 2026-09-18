/**
 * IME / composition coverage for the shared editor keyboard handler (I18N-016).
 *
 * The only composition guard in the app is `useEditorKeyboard`'s
 * `!e.nativeEvent.isComposing` check (useEditorKeyboard.ts): while an IME is
 * composing (e.g. picking a CJK candidate) the Enter that *confirms the
 * candidate* must NOT submit the form — only a later standalone Enter does.
 * These tests drive the REAL hook with a realistic
 * compositionstart → compositionupdate → compositionend → Enter sequence and
 * assert the confirm-Enter is swallowed, the committed string is intact, and
 * onSubmit fires exactly once (no double-processing).
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

function input(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('[data-testid="text"]')!;
}

/** Dispatch a keydown on the text input, optionally mid-composition. */
function pressEnter(isComposing: boolean): boolean {
  const el = input();
  const ev = new KeyboardEvent("keydown", {
    key: "Enter",
    isComposing,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    el.dispatchEvent(ev);
  });
  return ev.defaultPrevented;
}

/** Fire a composition event on the text input (jsdom has no real IME). */
function compose(type: "compositionstart" | "compositionupdate" | "compositionend", data: string) {
  const el = input();
  const ev = new CompositionEvent(type, { data, bubbles: true });
  act(() => {
    el.dispatchEvent(ev);
  });
}

describe("useEditorKeyboard IME composition (I18N-016)", () => {
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

  it("Enter that confirms an IME candidate does not submit the form", () => {
    const onSubmit = vi.fn();
    render({ onSubmit, onCancel: vi.fn() });

    // User is composing a CJK word; the Enter that picks the candidate carries
    // isComposing=true and must be swallowed by the guard.
    compose("compositionstart", "");
    compose("compositionupdate", "ni");
    const prevented = pressEnter(true);

    expect(onSubmit).not.toHaveBeenCalled();
    expect(prevented).toBe(false);
  });

  it("commits the composed CJK string and submits on the post-composition Enter (once)", () => {
    const onSubmit = vi.fn();
    render({ onSubmit, onCancel: vi.fn() });
    const el = input();

    // Full realistic sequence: compose "你好", confirm the candidate with an
    // Enter that is still isComposing=true (must NOT submit)...
    compose("compositionstart", "");
    compose("compositionupdate", "ni");
    el.value = "你好"; // IME commits the candidate into the field
    expect(pressEnter(true)).toBe(false);
    compose("compositionend", "你好");

    // ...then a real standalone Enter submits the now-committed value once.
    const prevented = pressEnter(false);

    expect(el.value).toBe("你好");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(prevented).toBe(true);
  });

  it("does not double-process: composing Enter + real Enter yields a single submit", () => {
    const onSubmit = vi.fn();
    render({ onSubmit, onCancel: vi.fn() });

    // Two candidate-confirm Enters during composition, then one real Enter.
    compose("compositionstart", "");
    pressEnter(true);
    pressEnter(true);
    compose("compositionend", "日本語");
    pressEnter(false);

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
