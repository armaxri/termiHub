import { describe, it, expect, vi } from "vitest";
import { decorateAutomationTyping, AUTOMATION_MARK_CLASS } from "./automationMarkDecorations";

/**
 * #6021: the mark of an automation's line: a tint under the row (below the text,
 * so copy and selection are untouched) and a badge at the row's right end that
 * says who typed it and opens its History.
 */
function fakeTerm() {
  const decorations: { options: Record<string, unknown>; el: HTMLElement; dispose: () => void }[] =
    [];
  const marker = { line: 3, isDisposed: false, dispose: vi.fn(), onDispose: vi.fn() };
  return {
    cols: 80,
    marker,
    decorations,
    registerMarker: vi.fn(() => marker),
    registerDecoration: vi.fn((options: Record<string, unknown>) => {
      const el = document.createElement("div");
      const handlers: ((el: HTMLElement) => void)[] = [];
      const decoration = {
        options,
        el,
        dispose: vi.fn(),
        onRender: (fn: (el: HTMLElement) => void) => {
          handlers.push(fn);
          fn(el);
          return { dispose: vi.fn() };
        },
      };
      decorations.push(decoration);
      return decoration;
    }),
  };
}

const TYPING = {
  automationId: "a1",
  name: "Deploy staging",
  origin: "scheduled" as const,
  at: new Date(2026, 10, 26, 14, 32, 8).getTime(),
};

describe("decorateAutomationTyping", () => {
  it("tints the row under the text and puts a badge with who typed it at its end", () => {
    const term = fakeTerm();
    const open = vi.fn();
    const mark = decorateAutomationTyping(term as never, TYPING, open);
    expect(term.registerMarker).toHaveBeenCalledWith(0);
    const [row, badge] = term.decorations;
    expect(row.options).toMatchObject({ marker: term.marker, width: 80, layer: "bottom" });
    expect(row.el.classList.contains(AUTOMATION_MARK_CLASS)).toBe(true);
    expect(badge.options).toMatchObject({ marker: term.marker, layer: "top" });
    expect(badge.el.getAttribute("title")).toContain("“Deploy staging”, on its schedule");
    expect(badge.el.getAttribute("role")).toBe("button");
    expect(badge.el.getAttribute("aria-label")).toBe(badge.el.getAttribute("title"));
    badge.el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(open).toHaveBeenCalledWith("a1");
    mark?.dispose();
    expect(row.dispose).toHaveBeenCalled();
    expect(badge.dispose).toHaveBeenCalled();
  });

  it("does nothing where xterm cannot place a marker", () => {
    const term = fakeTerm();
    term.registerMarker.mockReturnValue(undefined as never);
    expect(decorateAutomationTyping(term as never, TYPING, vi.fn())).toBeUndefined();
    expect(term.registerDecoration).not.toHaveBeenCalled();
  });
});
