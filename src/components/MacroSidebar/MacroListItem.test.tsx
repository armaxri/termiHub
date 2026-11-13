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

  it("shows the first line it types in the secondary text, not a joined dump (R-112)", () => {
    render(
      macro({
        steps: [
          { data: "echo one\r", delayMs: 0 },
          { data: "echo two\r", delayMs: 0 },
        ],
      })
    );
    const preview = query("macro-preview-m1")!;
    expect(preview.textContent).toBe("echo one");
    expect(preview.tagName).not.toBe("CODE");
    expect(preview.classList.contains("macro-item__preview")).toBe(true);
    // No step count on the row (#5519).
    expect(query("macro-item-m1")!.textContent).not.toMatch(/\bsteps?\b/);
  });

  it("lists every line it types in the preview's tooltip (R-112)", () => {
    render(
      macro({
        steps: [
          { data: "echo one\r", delayMs: 0 },
          { data: "echo two\r", delayMs: 0 },
        ],
      })
    );
    revealTooltip(query("macro-preview-m1")!);
    const steps = document.querySelector('[data-testid="macro-steps-m1"]');
    expect(steps).not.toBeNull();
    const lines = Array.from(steps!.querySelectorAll(".macro-item__step")).map(
      (el) => el.textContent
    );
    expect(lines).toEqual(["echo one", "echo two"]);
  });

  it("omits the preview for a macro with no input", () => {
    render(macro({ steps: [] }));
    expect(query("macro-preview-m1")).toBeNull();
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

  it("shows when and where it last ran (R-113)", () => {
    render(macro(), handlers(), { lastRun: run() });
    const line = query("macro-last-run-m1")!;
    expect(line.textContent).toBe("Last run: just now on pr-auto-local");
    expect(line.querySelector("time")).not.toBeNull();
  });

  it("names the terminal count for a multi-terminal last run", () => {
    render(macro(), handlers(), {
      lastRun: run({ targetCount: 3, targetLabels: ["a", "b", "c"] }),
    });
    expect(query("macro-last-run-m1")!.textContent).toContain("on 3 terminals");
  });

  it("has no last-run line before the first playback", () => {
    render(macro());
    expect(query("macro-last-run-m1")).toBeNull();
  });

  it("shows the description and tags when present", () => {
    render(macro({ description: "nightly job", tags: ["ops", "prod"] }));
    expect(container.textContent).toContain("nightly job");
    const tags = query("macro-tags-m1");
    expect(tags?.textContent).toContain("ops");
    expect(tags?.textContent).toContain("prod");
  });

  it("omits the tags element when there are no tags", () => {
    render(macro({ tags: [] }));
    expect(query("macro-tags-m1")).toBeNull();
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
