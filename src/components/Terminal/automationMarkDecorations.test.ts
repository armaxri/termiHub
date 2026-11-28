import { describe, it, expect, vi } from "vitest";
import {
  decorateAutomationTyping,
  placeAutomationMark,
  typedRowIndex,
  AUTOMATION_MARK_CLASS,
} from "./automationMarkDecorations";

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

describe("the mark sits on the line the input echoes on (#6183, automations-2)", () => {
  it("hangs the marker at the given offset from the cursor", () => {
    const term = fakeTerm();
    decorateAutomationTyping(term as never, TYPING, vi.fn(), -2);
    expect(term.registerMarker).toHaveBeenCalledWith(-2);
  });

  it("finds the row the typed text echoes on, at or after where it was typed", () => {
    // The cursor still sat on the output a wait-for-output matched; the command
    // echoed on the prompt below it.
    const rows = ["PR_WF_READY_42", "$ echo PR_WF_DONE", "PR_WF_DONE", "$ "];
    expect(typedRowIndex(rows, "echo PR_WF_DONE")).toBe(1);
  });

  it("does not take output that merely contains the text before its echo", () => {
    const rows = ["$ sleep 1; echo READY", "READY"];
    expect(typedRowIndex(rows, "sleep 1; echo READY")).toBe(0);
    expect(typedRowIndex(["READY", "$ "], "sleep 1; echo READY")).toBeNull();
  });

  it("matches a long command by its start, as the terminal may wrap it", () => {
    const long = `echo ${"x".repeat(120)}`;
    expect(typedRowIndex(["out", `$ ${long.slice(0, 60)}`], long)).toBe(1);
  });
});

describe("placeAutomationMark (#6183, automations-2)", () => {
  /** A terminal whose rows and cursor the test moves, and whose writes it fires. */
  function liveTerm(rows: string[], cursorRow: number) {
    const term = fakeTerm();
    const writes = new Set<() => void>();
    const buffer = {
      baseY: 0,
      cursorY: cursorRow,
      getLine: (i: number) => (i < rows.length ? { translateToString: () => rows[i] } : undefined),
    };
    return {
      ...term,
      buffer: { active: buffer },
      onWriteParsed: vi.fn((cb: () => void) => {
        writes.add(cb);
        return { dispose: () => writes.delete(cb) };
      }),
      write(newRows: string[], cursor: number) {
        rows.push(...newRows);
        buffer.cursorY = cursor;
        for (const cb of [...writes]) cb();
      },
      writes,
    };
  }

  it("waits for the echo and marks that row, not the output the cursor was on", () => {
    const rows = ["$ sleep 1; echo READY", "READY"];
    const term = liveTerm(rows, 1);
    placeAutomationMark(term as never, { ...TYPING, text: "echo DONE" }, vi.fn());
    expect(term.registerMarker).not.toHaveBeenCalled();
    term.write(["$ echo DONE", "DONE"], 3);
    // The echo is on row 2; the cursor on row 3: one row up.
    expect(term.registerMarker).toHaveBeenCalledWith(-1);
    expect(term.writes.size).toBe(0);
  });

  it("marks at once when the echo is already there", () => {
    const term = liveTerm(["$ echo DONE"], 0);
    placeAutomationMark(term as never, { ...TYPING, text: "echo DONE" }, vi.fn());
    expect(term.registerMarker).toHaveBeenCalledWith(0);
  });

  it("marks the cursor's row for a short key, as before", () => {
    const term = liveTerm(["$ "], 0);
    placeAutomationMark(term as never, { ...TYPING, text: "q" }, vi.fn());
    expect(term.registerMarker).toHaveBeenCalledWith(0);
  });

  it("gives up without a mark when the echo never comes", () => {
    vi.useFakeTimers();
    try {
      const term = liveTerm(["READY"], 0);
      const placed = placeAutomationMark(term as never, { ...TYPING, text: "echo DONE" }, vi.fn());
      vi.advanceTimersByTime(5000);
      expect(term.registerMarker).not.toHaveBeenCalled();
      expect(term.writes.size).toBe(0);
      placed.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
