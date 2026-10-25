/**
 * ResponsiveToolbar (#4709, #4824): actions render labelled while they all fit;
 * below that the primary action (if declared) stays inline and every other
 * action moves into one overflow "…" menu — never clipped or hidden, and never
 * an icon-only row.
 *
 * jsdom has no layout, so the toolbar falls back to estimated widths
 * (28px per icon button, 28px + 7px per label character) and the tests drive
 * the container width through a controllable ResizeObserver.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, StrictMode } from "react";
import { createRoot, Root } from "react-dom/client";
import { Plus, Save, Download, Upload } from "lucide-react";
import { ResponsiveToolbar, computeToolbarLayout } from "./ResponsiveToolbar";
import type { ToolbarAction } from "./ResponsiveToolbar";
import { withTooltip } from "@/test/tooltip";
import { checkA11y } from "@/test/axe";
import { installResizeObserverMock, type ResizeObserverMock } from "@/test/resizeObserver";

let container: HTMLDivElement;
let root: Root;
let ro: ResizeObserverMock;

beforeEach(() => {
  ro = installResizeObserverMock();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  ro.restore();
});

function makeActions(handlers: Record<string, () => void> = {}): ToolbarAction[] {
  return [
    {
      id: "new",
      label: "New Workspace",
      icon: <Plus size={14} />,
      onClick: handlers.new,
      primary: true,
      testId: "tb-new",
    },
    {
      id: "save",
      label: "Save Current Layout",
      shortLabel: "Save Current",
      icon: <Save size={14} />,
      onClick: handlers.save,
      testId: "tb-save",
    },
    {
      id: "export",
      label: "Export Workspaces",
      icon: <Download size={14} />,
      onClick: handlers.export,
      iconOnly: true,
      testId: "tb-export",
    },
    {
      id: "import",
      label: "Import Workspaces",
      icon: <Upload size={14} />,
      onClick: handlers.import,
      iconOnly: true,
      testId: "tb-import",
    },
  ];
}

function render(actions: ToolbarAction[] = makeActions(), { strict = false } = {}) {
  const toolbar = (
    <ResponsiveToolbar
      actions={actions}
      aria-label="Workspace actions"
      overflowLabel="More workspace actions"
      overflowTestId="tb-overflow"
      data-testid="tb"
    />
  );
  act(() => root.render(withTooltip(strict ? <StrictMode>{toolbar}</StrictMode> : toolbar)));
}

/** The live (non-measuring) buttons of the toolbar, by accessible name. */
function liveButton(name: string): HTMLButtonElement | null {
  const toolbar = container.querySelector('[data-testid="tb"]');
  const buttons = Array.from(toolbar?.querySelectorAll<HTMLButtonElement>(":scope > button") ?? []);
  return buttons.find((b) => b.getAttribute("aria-label") === name) ?? null;
}

function layout(): string | null {
  return container.querySelector('[data-testid="tb"]')?.getAttribute("data-layout") ?? null;
}

function openOverflow() {
  const trigger = container.querySelector<HTMLButtonElement>('[data-testid="tb-overflow"]');
  if (!trigger) throw new Error("no overflow trigger");
  act(() => {
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

function menuItemNames(): string[] {
  return Array.from(document.querySelectorAll('[role="menuitem"]')).map(
    (el) => el.textContent ?? ""
  );
}

const ALL_NAMES = [
  "New Workspace",
  "Save Current Layout",
  "Export Workspaces",
  "Import Workspaces",
];

describe("computeToolbarLayout", () => {
  // Labelled widths: 119 + 112 + 28 + 28 + 3 gaps × 4 = 299 for the full strip.
  const input = { fullWidths: [119, 112, 28, 28], iconWidth: 28, gap: 4, primaryIndex: 0 };

  it("is full when the width is unknown", () => {
    expect(computeToolbarLayout({ ...input, available: null })).toEqual({
      mode: "full",
      inlineIndex: null,
    });
  });

  it("keeps labels while they all fit", () => {
    expect(computeToolbarLayout({ ...input, available: 299 }).mode).toBe("full");
    // Sub-pixel rounding does not flip a strip that fits.
    expect(computeToolbarLayout({ ...input, available: 298.6 }).mode).toBe("full");
  });

  it("keeps only the primary action beside the overflow trigger once labels do not fit", () => {
    // Never an icon-only row: one pixel short of full goes straight to overflow.
    expect(computeToolbarLayout({ ...input, available: 298 })).toEqual({
      mode: "overflow",
      inlineIndex: 0,
    });
    // Primary (119) + gap (4) + trigger (28) = 151.
    expect(computeToolbarLayout({ ...input, available: 151 })).toEqual({
      mode: "overflow",
      inlineIndex: 0,
    });
  });

  it("puts everything in the menu when even the primary does not fit beside the trigger", () => {
    expect(computeToolbarLayout({ ...input, available: 150 })).toEqual({
      mode: "overflow",
      inlineIndex: null,
    });
  });

  it("keeps a primary that is not the first action", () => {
    expect(computeToolbarLayout({ ...input, primaryIndex: 1, available: 200 })).toEqual({
      mode: "overflow",
      inlineIndex: 1,
    });
  });

  it("shows only the overflow trigger when no primary is declared", () => {
    expect(computeToolbarLayout({ ...input, primaryIndex: null, available: 298 })).toEqual({
      mode: "overflow",
      inlineIndex: null,
    });
  });
});

describe("ResponsiveToolbar", () => {
  it("renders labelled buttons while there is room", () => {
    render();
    ro.resize(400);
    expect(layout()).toBe("full");
    expect(liveButton("New Workspace")?.textContent).toBe("New Workspace");
    expect(liveButton("Save Current Layout")?.textContent).toBe("Save Current");
    // Export/import are icon-only in every layout.
    expect(liveButton("Export Workspaces")?.textContent).toBe("");
    expect(container.querySelector('[data-testid="tb-overflow"]')).toBeNull();
  });

  it("collapses to the labelled primary plus one overflow menu — no icon-only row", () => {
    const onSave = vi.fn();
    render(makeActions({ save: onSave }));
    // 200px minimum sidebar width minus the toolbar's horizontal padding.
    ro.resize(184);
    expect(layout()).toBe("overflow");
    expect(liveButton("New Workspace")?.textContent).toBe("New Workspace");
    expect(liveButton("Save Current Layout")).toBeNull();
    expect(liveButton("Export Workspaces")).toBeNull();
    expect(liveButton("Import Workspaces")).toBeNull();
    const trigger = container.querySelector('[data-testid="tb-overflow"]');
    expect(trigger?.getAttribute("aria-label")).toBe("More workspace actions");

    openOverflow();
    expect(menuItemNames()).toEqual([
      "Save Current Layout",
      "Export Workspaces",
      "Import Workspaces",
    ]);
    // Test hooks follow the action into the menu, and the item runs it.
    const save = document.querySelector<HTMLElement>('[data-testid="tb-save"]');
    expect(save?.getAttribute("role")).toBe("menuitem");
    act(() => save?.click());
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("runs the same handler from every overflow item as from its button (MT-UI-53)", () => {
    const handlers = { new: vi.fn(), save: vi.fn(), export: vi.fn(), import: vi.fn() };
    render(makeActions(handlers).map((a) => ({ ...a, primary: undefined })));
    ro.resize(400);
    for (const name of ALL_NAMES) act(() => liveButton(name)?.click());
    const viaButtons = Object.values(handlers).map((h) => h.mock.calls.length);
    expect(viaButtons).toEqual([1, 1, 1, 1]);

    ro.resize(40);
    for (const name of ALL_NAMES) {
      openOverflow();
      const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
        (el) => el.textContent === name
      );
      act(() => item?.click());
    }
    expect(Object.values(handlers).map((h) => h.mock.calls.length)).toEqual([2, 2, 2, 2]);
  });

  it("goes straight from labels to the overflow menu just below the full width", () => {
    render();
    ro.resize(298);
    expect(layout()).toBe("overflow");
    const toolbar = container.querySelector('[data-testid="tb"]');
    const iconOnlyLive = Array.from(
      toolbar?.querySelectorAll(":scope > .ui-btn--icon-only") ?? []
    ).map((b) => b.getAttribute("aria-label"));
    // The only icon-only control left inline is the "…" trigger itself.
    expect(iconOnlyLive).toEqual(["More workspace actions"]);
  });

  it("still collapses under React StrictMode's double mount (#4736)", () => {
    render(makeActions(), { strict: true });
    ro.resize(184);
    expect(layout()).toBe("overflow");
    expect(container.querySelector('[data-testid="tb-overflow"]')).not.toBeNull();
    expect(liveButton("New Workspace")).not.toBeNull();
    ro.resize(400);
    expect(layout()).toBe("full");
    expect(container.querySelector('[data-testid="tb-overflow"]')).toBeNull();
  });

  it("moves every action into the menu when no primary is declared", () => {
    render(makeActions().map((a) => ({ ...a, primary: undefined })));
    ro.resize(184);
    expect(layout()).toBe("overflow");
    expect(ALL_NAMES.map(liveButton).filter(Boolean)).toHaveLength(0);
    openOverflow();
    expect(menuItemNames()).toEqual(ALL_NAMES);
  });

  it("keeps every action reachable by name at a very narrow width", () => {
    render();
    ro.resize(40);
    const inline = ALL_NAMES.map(liveButton).filter(Boolean);
    openOverflow();
    expect(inline.length + menuItemNames().length).toBe(4);
    expect(menuItemNames()).toContain("New Workspace");
  });

  it("restores the labels when the toolbar grows again", () => {
    render();
    ro.resize(92);
    expect(layout()).toBe("overflow");
    ro.resize(400);
    expect(layout()).toBe("full");
    expect(liveButton("Import Workspaces")).not.toBeNull();
  });

  it("turns a drop-down action into a sub-menu when it overflows", () => {
    const onBlank = vi.fn();
    render([
      ...makeActions().slice(2),
      {
        id: "new",
        label: "New Workflow",
        shortLabel: "New",
        icon: <Plus size={12} />,
        testId: "tb-new-menu",
        menu: [{ id: "blank", label: "Blank workflow", onSelect: onBlank, testId: "tb-blank" }],
      },
    ]);
    ro.resize(60);
    openOverflow();
    const sub = document.querySelector('[data-testid="tb-new-menu"]');
    expect(sub?.getAttribute("aria-haspopup")).toBe("menu");
    expect(sub?.textContent).toContain("New Workflow");
  });

  it("keeps a primary drop-down inline as a labelled menu button", () => {
    render([
      {
        id: "new",
        label: "New Workflow",
        shortLabel: "New",
        icon: <Plus size={12} />,
        primary: true,
        testId: "tb-new-menu",
        menu: [{ id: "blank", label: "Blank workflow", onSelect: vi.fn() }],
      },
      ...makeActions().slice(2),
    ]);
    // Full: 28 + 3 × 7 + 16 = 65, + 2 × 28 + 2 × 4 = 129. Primary + trigger = 97.
    ro.resize(100);
    expect(layout()).toBe("overflow");
    const button = liveButton("New Workflow");
    expect(button?.textContent).toBe("New");
    expect(button?.getAttribute("aria-haspopup")).toBe("menu");
    openOverflow();
    expect(menuItemNames()).toEqual(["Export Workspaces", "Import Workspaces"]);
  });

  it("has no axe violations in every layout", async () => {
    render();
    ro.resize(400);
    expect(await checkA11y(container)).toHaveNoViolations();
    ro.resize(184);
    expect(await checkA11y(container)).toHaveNoViolations();
    ro.resize(92);
    expect(await checkA11y(container)).toHaveNoViolations();
    openOverflow();
    expect(await checkA11y()).toHaveNoViolations();
  });
});
