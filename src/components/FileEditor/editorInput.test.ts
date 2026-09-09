import { describe, it, expect, vi } from "vitest";
import {
  CURSOR_TRIGGER_SOURCE,
  EDITOR_INPUT_TESTID,
  findMonacoInput,
  moveEditorCursor,
  tagMonacoInput,
  testInputEditorOptions,
} from "./editorInput";

/**
 * Build a fake Monaco editor DOM node containing the given hidden-input element,
 * mirroring the two shapes Monaco produces depending on `EditContext` support.
 */
function editorDomNode(inputHtml: string): HTMLElement {
  const node = document.createElement("div");
  node.className = "monaco-editor";
  node.innerHTML = `<div class="overflow-guard">${inputHtml}</div>`;
  return node;
}

describe("Monaco hidden-input tagging (#2689)", () => {
  it("tags the textarea input on engines without EditContext (WebKitGTK / WKWebView)", () => {
    const node = editorDomNode(`<textarea class="inputarea"></textarea>`);
    tagMonacoInput(node);
    const input = node.querySelector("textarea.inputarea")!;
    expect(input.getAttribute("data-testid")).toBe(EDITOR_INPUT_TESTID);
  });

  it("tags the native-edit-context div on EditContext engines (WebView2 / Chromium)", () => {
    // Regression for #2689: on WebView2, Monaco powers input through a
    // `<div class="native-edit-context">`, not a `textarea.inputarea`, so the
    // textarea-only selector left `editor-input` unset and the harness could
    // not find the editor input at all.
    const node = editorDomNode(`<div class="native-edit-context"></div>`);
    tagMonacoInput(node);
    const input = node.querySelector(".native-edit-context")!;
    expect(input.getAttribute("data-testid")).toBe(EDITOR_INPUT_TESTID);
  });

  it("finds whichever input element the engine created", () => {
    expect(
      findMonacoInput(editorDomNode(`<textarea class="inputarea"></textarea>`))
    ).not.toBeNull();
    expect(
      findMonacoInput(editorDomNode(`<div class="native-edit-context"></div>`))
    ).not.toBeNull();
  });

  it("does not tag the IME helper textarea of the native edit context", () => {
    // The native edit context also mounts a hidden `<textarea class="ime-text-area">`;
    // the addressable input is the div, so the textarea selector must not match it.
    const node = editorDomNode(
      `<div class="native-edit-context"></div><textarea class="ime-text-area"></textarea>`
    );
    tagMonacoInput(node);
    expect(node.querySelector("textarea.ime-text-area")!.getAttribute("data-testid")).toBeNull();
    expect(node.querySelector(".native-edit-context")!.getAttribute("data-testid")).toBe(
      EDITOR_INPUT_TESTID
    );
  });

  it("is a no-op when the node or input is absent", () => {
    expect(() => tagMonacoInput(null)).not.toThrow();
    expect(() => tagMonacoInput(undefined)).not.toThrow();
    expect(findMonacoInput(editorDomNode(`<span></span>`))).toBeNull();
  });
});

describe("test-bridge editor input mode (#2694)", () => {
  it("forces the textarea input (editContext off) when the bridge is active", () => {
    // Under the bridge, Monaco must use the classic `<textarea class="inputarea">`
    // input rather than the Chromium `EditContext` path. Arrow-key cursor
    // navigation is gated on Monaco's `textInputFocus` context key, which the
    // bridge's `pressKey` flips by dispatching a synthetic `focus` event at the
    // input. Only the textarea input honours that synthetic event (its
    // `TextAreaInput` sets focus straight from the DOM `focus`); the EditContext
    // input's `FocusTracker` instead re-reads `document.activeElement` and
    // ignores it, so `textInputFocus` never flips on an occluded CI webview and
    // arrows silently no-op — the #2694 macOS/WebKit failure. Forcing textarea
    // mode makes the keyboard path engine-agnostic across all three webviews.
    expect(testInputEditorOptions(true)).toEqual({ editContext: false });
  });

  it("leaves EditContext untouched in production (bridge off)", () => {
    // Real users keep Monaco's default input path; the override is test-only.
    expect(testInputEditorOptions(false)).toEqual({});
  });
});

describe("moveEditorCursor — command API caret navigation (#2694)", () => {
  it("invokes Monaco's core cursor command per direction, not a synthetic key", () => {
    // The deterministic #2694 failure was that an arrow keydown never moved the
    // caret on an occluded CI webview (Monaco's `textInputFocus` gate stays
    // false without genuine input focus). Driving the *command* directly has no
    // focus precondition, so it must map each direction to Monaco's core cursor
    // command id and trigger it — engine- and focus-independent.
    for (const [direction, handlerId] of [
      ["up", "cursorUp"],
      ["down", "cursorDown"],
      ["left", "cursorLeft"],
      ["right", "cursorRight"],
    ] as const) {
      const trigger = vi.fn();
      moveEditorCursor({ trigger }, direction);
      expect(trigger).toHaveBeenCalledTimes(1);
      expect(trigger).toHaveBeenCalledWith(CURSOR_TRIGGER_SOURCE, handlerId, null);
    }
  });

  it("repeats the command `times` times (each step fires its own cursor move)", () => {
    // Each single-step command fires its own onDidChangeCursorPosition, so the
    // status bar reflects the final Ln/Col after N steps — the loop must trigger
    // exactly N times.
    const trigger = vi.fn();
    moveEditorCursor({ trigger }, "down", 3);
    expect(trigger).toHaveBeenCalledTimes(3);
    expect(trigger).toHaveBeenNthCalledWith(1, CURSOR_TRIGGER_SOURCE, "cursorDown", null);
    expect(trigger).toHaveBeenNthCalledWith(3, CURSOR_TRIGGER_SOURCE, "cursorDown", null);
  });

  it("defaults to a single step", () => {
    const trigger = vi.fn();
    moveEditorCursor({ trigger }, "up");
    expect(trigger).toHaveBeenCalledTimes(1);
  });
});
