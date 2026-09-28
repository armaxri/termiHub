import type React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  POST_COMPOSITION_KEYDOWN_WINDOW_MS,
  isImeComposing,
  resetImeCompositionTrackerForTests,
} from "./imeComposition";

let input: HTMLInputElement;
let other: HTMLInputElement;
let clock = 0;

function compose(el: HTMLElement, type: "compositionstart" | "compositionend") {
  el.dispatchEvent(new CompositionEvent(type, { data: "", bubbles: true }));
}

/** Dispatch a keydown and return whether the helper classified it as composing. */
function keydown(el: HTMLElement, init: KeyboardEventInit): boolean {
  let result: boolean | undefined;
  const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  const listener = (e: Event) => {
    result = isImeComposing(e as KeyboardEvent);
  };
  el.addEventListener("keydown", listener);
  el.dispatchEvent(ev);
  el.removeEventListener("keydown", listener);
  return result!;
}

describe("isImeComposing (#3767)", () => {
  beforeEach(() => {
    input = document.createElement("input");
    other = document.createElement("input");
    document.body.append(input, other);
    clock = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    resetImeCompositionTrackerForTests();
  });

  afterEach(() => {
    input.remove();
    other.remove();
    vi.restoreAllMocks();
    resetImeCompositionTrackerForTests();
  });

  it("is false for a plain keydown", () => {
    expect(keydown(input, { key: "Enter" })).toBe(false);
  });

  it("honours isComposing and keyCode 229", () => {
    expect(keydown(input, { key: "Enter", isComposing: true })).toBe(true);
    expect(keydown(input, { key: "Enter", keyCode: 229 })).toBe(true);
  });

  it("is true for keydowns on the composing element between start and end", () => {
    compose(input, "compositionstart");
    expect(keydown(input, { key: "Escape" })).toBe(true);
    expect(keydown(other, { key: "Escape" })).toBe(false);
  });

  it("treats the single keydown immediately after compositionend as composing", () => {
    compose(input, "compositionstart");
    compose(input, "compositionend");
    expect(keydown(input, { key: "Enter" })).toBe(true);
    expect(keydown(input, { key: "Enter" })).toBe(false);
  });

  it("does not swallow a deliberate keydown after the post-composition window", () => {
    compose(input, "compositionstart");
    compose(input, "compositionend");
    clock += POST_COMPOSITION_KEYDOWN_WINDOW_MS + 1;
    expect(keydown(input, { key: "Enter" })).toBe(false);
  });

  it("clears a composition whose field lost focus without compositionend", () => {
    compose(input, "compositionstart");
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(keydown(input, { key: "Enter" })).toBe(false);
  });

  it("accepts a React synthetic event via nativeEvent", () => {
    const nativeEvent = new KeyboardEvent("keydown", { key: "Enter", keyCode: 229 });
    expect(isImeComposing({ nativeEvent } as unknown as React.KeyboardEvent)).toBe(true);
  });
});
