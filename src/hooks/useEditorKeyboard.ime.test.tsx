/**
 * IME / composition coverage for the shared editor keyboard handler (I18N-016).
 *
 * `useEditorKeyboard` guards Enter and Escape with the shared
 * `isImeComposing` helper (src/utils/imeComposition.ts): while an IME is
 * composing (e.g. picking a CJK candidate) the Enter that *confirms the
 * candidate* must NOT submit the form — only a later standalone Enter does —
 * and an Escape that cancels the preedit must NOT close the editor.
 * These tests drive the REAL hook with realistic composition sequences in both
 * the Chromium order (Enter keydown with isComposing=true, then
 * compositionend) and the WebKit order (compositionend, then an Enter keydown
 * with isComposing=false / keyCode 229) — #3767.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useEditorKeyboard, type EditorKeyboardOptions } from "./useEditorKeyboard";
import {
  POST_COMPOSITION_KEYDOWN_WINDOW_MS,
  resetImeCompositionTrackerForTests,
} from "../utils/imeComposition";

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
/** Fake `performance.now()` clock driving the post-compositionend window. */
let clock = 0;

/** Let time pass, as between a composition commit and a deliberate keypress. */
function advance(ms: number) {
  clock += ms;
}

function render(opts: EditorKeyboardOptions) {
  act(() => {
    root.render(<Harness {...opts} />);
  });
}

function input(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('[data-testid="text"]')!;
}

/** Dispatch a keydown on the text input, optionally mid-composition. */
function press(key: string, isComposing: boolean, keyCode = 0): boolean {
  const el = input();
  const ev = new KeyboardEvent("keydown", {
    key,
    isComposing,
    keyCode,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    el.dispatchEvent(ev);
  });
  return ev.defaultPrevented;
}

function pressEnter(isComposing: boolean, keyCode = 0): boolean {
  return press("Enter", isComposing, keyCode);
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
    clock = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    resetImeCompositionTrackerForTests();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    resetImeCompositionTrackerForTests();
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
    advance(500);

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
    advance(500);
    pressEnter(false);

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("Enter during an active composition does not submit even without isComposing", () => {
    const onSubmit = vi.fn();
    render({ onSubmit, onCancel: vi.fn() });

    // Some engines drop isComposing entirely; the explicit
    // compositionstart tracking must still hold the Enter back.
    compose("compositionstart", "");
    compose("compositionupdate", "ni");
    const prevented = pressEnter(false);

    expect(onSubmit).not.toHaveBeenCalled();
    expect(prevented).toBe(false);
  });

  it("WebKit order: the Enter right after compositionend (keyCode 229) does not submit", () => {
    const onSubmit = vi.fn();
    render({ onSubmit, onCancel: vi.fn() });
    const el = input();

    compose("compositionstart", "");
    compose("compositionupdate", "nihongo");
    el.value = "日本語";
    // WKWebView / WebKitGTK: compositionend fires BEFORE the confirming keydown,
    // which then carries isComposing=false and keyCode 229.
    compose("compositionend", "日本語");
    expect(pressEnter(false, 229)).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();

    // The user's deliberate second Enter saves exactly once.
    advance(500);
    expect(pressEnter(false)).toBe(true);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(el.value).toBe("日本語");
  });

  it("WebKit order: the Enter right after compositionend does not submit even without keyCode 229", () => {
    const onSubmit = vi.fn();
    render({ onSubmit, onCancel: vi.fn() });

    compose("compositionstart", "");
    compose("compositionend", "日本語");
    advance(POST_COMPOSITION_KEYDOWN_WINDOW_MS / 2);
    pressEnter(false);

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("only the single keydown immediately after compositionend is swallowed", () => {
    const onSubmit = vi.fn();
    render({ onSubmit, onCancel: vi.fn() });

    compose("compositionstart", "");
    compose("compositionend", "日本語");
    pressEnter(false); // confirm-Enter (WebKit order) — swallowed
    pressEnter(false); // an immediate second keydown is a real Enter

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("a keyCode 229 Enter outside any tracked composition does not submit", () => {
    const onSubmit = vi.fn();
    render({ onSubmit, onCancel: vi.fn() });

    expect(pressEnter(false, 229)).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("a normal Enter with no composition submits", () => {
    const onSubmit = vi.fn();
    render({ onSubmit, onCancel: vi.fn() });

    expect(pressEnter(false)).toBe(true);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("Escape during composition does not cancel the editor", () => {
    const onCancel = vi.fn();
    render({ onSubmit: vi.fn(), onCancel });

    compose("compositionstart", "");
    compose("compositionupdate", "tesuto");
    const prevented = press("Escape", true);

    expect(onCancel).not.toHaveBeenCalled();
    expect(prevented).toBe(false);
  });

  it("Escape that cancels the preedit in WebKit order does not cancel the editor", () => {
    const onCancel = vi.fn();
    render({ onSubmit: vi.fn(), onCancel });

    compose("compositionstart", "");
    compose("compositionupdate", "tesuto");
    compose("compositionend", "");
    press("Escape", false, 229);

    expect(onCancel).not.toHaveBeenCalled();
  });

  it("a normal Escape after the composition has ended cancels", () => {
    const onCancel = vi.fn();
    render({ onSubmit: vi.fn(), onCancel });

    compose("compositionstart", "");
    compose("compositionend", "日本語");
    advance(500);
    press("Escape", false);

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
