import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { MacroListItem } from "./MacroListItem";
import { withTooltip } from "@/test/tooltip";
import type { Macro } from "@/types/macro";

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

function render(m: Macro, h = handlers()) {
  act(() => {
    root.render(withTooltip(<MacroListItem macro={m} {...h} />));
  });
  return h;
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

  it("renders name and a pluralised step-count badge", () => {
    render(macro({ steps: [{ data: "a", delayMs: 0 }] }));
    expect(query("macro-name-m1")?.textContent).toBe("Deploy");
    expect(query("macro-steps-m1")?.textContent).toBe("1 step");
  });

  it("pluralises the step badge for zero or multiple steps", () => {
    render(macro({ steps: [] }));
    expect(query("macro-steps-m1")?.textContent).toBe("0 steps");
  });

  it("renders a control-char preview from the recorded steps", () => {
    render(macro({ steps: [{ data: "ls\r", delayMs: 0 }] }));
    const preview = query("macro-preview-m1");
    expect(preview).not.toBeNull();
    // "\r" renders as the ⏎ glyph via macroStepFormat, never a raw carriage return.
    expect(preview?.textContent).toContain("ls");
    expect(preview?.textContent).toContain("⏎");
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
