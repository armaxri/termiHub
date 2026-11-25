import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseMacroStepText } from "./keysFormat";
import { MoreKeys } from "./MoreKeys";

describe("the keys that have no letter (B-013)", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onInsert = vi.fn();

  beforeEach(() => {
    onInsert.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<MoreKeys path="0" onInsert={onInsert} />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it.each([
    ["Tab", "\t"],
    ["Esc", "\x1b"],
    ["↑", "\x1b[A"],
    ["Home", "\x1b[H"],
    ["Delete", "\x1b[3~"],
    ["F5", "\x1b[15~"],
    ["F12", "\x1b[24~"],
    ["Ctrl+C", "\x03"],
  ])("inserts %s as what a terminal receives", (name, data) => {
    const button = document.querySelector<HTMLElement>(
      `[data-testid="automation-editor-keys-key-0-${name}"]`
    );
    act(() => button!.click());
    expect(parseMacroStepText(onInsert.mock.calls[0][0])).toEqual({ ok: true, data });
  });

  it("names the arrows for a screen reader", () => {
    const names = [...document.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
    expect(names).toContain("Arrow up");
    expect(new Set(names).size).toBe(names.length);
  });
});
