import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { MacroListItem } from "./MacroListItem";
import { withTooltip } from "@/test/tooltip";
import type { Macro, MacroRun } from "@/types/macro";

function macro(overrides: Partial<Macro> = {}): Macro {
  return {
    id: "m1",
    name: "Deploy",
    description: "",
    tags: [],
    steps: [{ data: "ls\r", delayMs: 0 }],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function handlers() {
  return {
    onPlay: vi.fn(),
    onEdit: vi.fn(),
    onDuplicate: vi.fn(),
    onExport: vi.fn(),
    onDelete: vi.fn(),
  };
}

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function render(
  m: Macro,
  h = handlers(),
  extra: { playTarget?: string | null; lastRun?: MacroRun } = {}
) {
  act(() => {
    root.render(withTooltip(<MacroListItem macro={m} {...h} {...extra} />));
  });
  return h;
}

/** Reveal a non-focusable trigger's tooltip through its focus handler. */
function revealTooltip(el: Element) {
  act(() => {
    el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  });
}

/** Reveal a focusable trigger's tooltip by focusing it. */
function focus(el: HTMLElement) {
  act(() => {
    el.focus();
    el.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
  });
}

function tooltipText(): string | null {
  return document.querySelector('[role="tooltip"]')?.textContent ?? null;
}

function run(overrides: Partial<MacroRun> = {}): MacroRun {
  return {
    id: "r1",
    macroId: "m1",
    macroName: "Deploy",
    startedAt: new Date(Date.now() - 2000).toISOString(),
    endedAt: new Date().toISOString(),
    status: "completed",
    stepsPlayed: 1,
    totalSteps: 1,
    targetCount: 1,
    targetLabels: ["pr-auto-local"],
    origin: "manual",
    ...overrides,
  };
}

describe("MacroListItem", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the name first with no step-count badge (#5519)", () => {
    render(macro({ steps: [{ data: "a", delayMs: 0 }] }));
    expect(query("macro-name-m1")?.textContent).toBe("Deploy");
    const header = query("macro-item-m1")?.querySelector(".sidebar-list-item__header");
    expect(header?.textContent?.startsWith("Deploy")).toBe(true);
    expect(query("macro-item-m1")?.querySelector(".sidebar-list-item__badge")).toBeNull();
  });

  it("keeps the Play action visible at rest, after the name (#5636)", () => {
    render(macro());
    const row = query("macro-item-m1")!;
    // The row opts into always-visible actions, so Play needs no hover.
    expect(row.classList.contains("sidebar-list-item--actions-visible")).toBe(true);
    const play = query("macro-play-m1")!;
    expect(play.getAttribute("aria-label")).toBe("Play");
    // Play is not part of the hover-revealed secondary group.
    expect(play.closest(".macro-item__more")).toBeNull();
    // The name still comes first in the header (#5519).
    const header = row.querySelector(".sidebar-list-item__header")!;
    expect(header.firstElementChild).toBe(query("macro-name-m1"));
  });

  it("keeps the secondary actions in a labelled hover/focus group (#5636)", () => {
    render(macro());
    const more = query("macro-more-m1")!;
    expect(more.classList.contains("macro-item__more")).toBe(true);
    expect(more.getAttribute("role")).toBe("group");
    expect(more.getAttribute("aria-label")).toBe("More actions for Deploy");
    for (const id of ["edit", "duplicate", "export", "delete"]) {
      expect(more.querySelector(`[data-testid="macro-${id}-m1"]`)).not.toBeNull();
    }
  });

  it("keeps what it types off the row and lists it in the tooltip (R-112, #5757)", () => {
    render(
      macro({
        steps: [
          { data: "echo one\r", delayMs: 0 },
          { data: "echo two\r", delayMs: 0 },
        ],
      })
    );
    const row = query("macro-item-m1")!;
    expect(query("macro-preview-m1")).toBeNull();
    expect(row.textContent).not.toContain("echo one");
    // No step count on the row (#5519).
    expect(row.textContent).not.toMatch(/\bsteps?\b/);
    expect(row.getAttribute("aria-description")).toBe("Types: echo one. echo two");
    revealTooltip(query("macro-name-m1")!);
    const tip = document.querySelector(
      '[data-testid="macro-tooltip-m1"] .sidebar-list-item__tooltip'
    );
    const lines = Array.from(tip!.querySelectorAll(".sidebar-list-item__tooltip-line")).map(
      (el) => el.textContent
    );
    expect(lines).toEqual(["Types:", "echo one", "echo two"]);
  });

  it("has no tooltip lines for a macro with no input, tags or runs", () => {
    render(macro({ steps: [] }));
    expect(query("macro-item-m1")!.getAttribute("aria-description")).toBeNull();
  });

  it("names the terminal Play types into (R-113)", () => {
    render(macro(), handlers(), { playTarget: "pr-auto-local" });
    focus(query("macro-play-m1")!);
    expect(tooltipText()).toContain("Play in: pr-auto-local");
  });

  it("says when there is no terminal to play into (R-113)", () => {
    render(macro(), handlers(), { playTarget: null });
    focus(query("macro-play-m1")!);
    expect(tooltipText()).toContain("no active terminal");
  });

  it("puts when and where it last ran in the tooltip, not on the row (R-113, #5757)", () => {
    render(macro({ steps: [] }), handlers(), { lastRun: run() });
    expect(query("macro-last-run-m1")).toBeNull();
    expect(query("macro-item-m1")!.textContent).not.toContain("Last run");
    expect(query("macro-item-m1")!.getAttribute("aria-description")).toBe(
      "Last run: just now on pr-auto-local"
    );
  });

  it("names the terminal count for a multi-terminal last run", () => {
    render(macro({ steps: [] }), handlers(), {
      lastRun: run({ targetCount: 3, targetLabels: ["a", "b", "c"] }),
    });
    expect(query("macro-item-m1")!.getAttribute("aria-description")).toContain("on 3 terminals");
  });

  it("shows the description on the row and the tags in the tooltip (#5757)", () => {
    render(macro({ steps: [], description: "nightly job", tags: ["ops", "prod"] }));
    expect(query("macro-description-m1")?.textContent).toBe("nightly job");
    expect(query("macro-tags-m1")).toBeNull();
    expect(query("macro-item-m1")!.textContent).toBe("Deploynightly job");
    expect(query("macro-item-m1")!.getAttribute("aria-description")).toBe("Tags: ops, prod");
  });

  it("shows no description line when none is set", () => {
    render(macro({ description: undefined }));
    expect(query("macro-description-m1")).toBeNull();
  });

  it("invokes each action handler with the macro id on click", () => {
    const h = render(macro());
    act(() => query("macro-play-m1")?.click());
    expect(h.onPlay).toHaveBeenCalledWith("m1");
    act(() => query("macro-edit-m1")?.click());
    expect(h.onEdit).toHaveBeenCalledWith("m1");
    act(() => query("macro-duplicate-m1")?.click());
    expect(h.onDuplicate).toHaveBeenCalledWith("m1");
    act(() => query("macro-export-m1")?.click());
    expect(h.onExport).toHaveBeenCalledWith("m1");
    act(() => query("macro-delete-m1")?.click());
    expect(h.onDelete).toHaveBeenCalledWith("m1");
  });

  it("plays the macro on row double-click", () => {
    const h = render(macro());
    act(() => {
      query("macro-item-m1")?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(h.onPlay).toHaveBeenCalledWith("m1");
  });
});
