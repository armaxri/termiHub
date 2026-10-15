/**
 * ResponsiveToolbar (#4709): actions render labelled while they fit, collapse to
 * icon-only buttons (tooltip + accessible name) below that, and move into an
 * overflow "…" menu after that — never clipped or hidden.
 *
 * jsdom has no layout, so the toolbar falls back to estimated widths
 * (28px per icon button, 28px + 7px per label character) and the tests drive
 * the container width through a controllable ResizeObserver.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
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

function render(actions: ToolbarAction[] = makeActions()) {
  act(() =>
    root.render(
      withTooltip(
        <ResponsiveToolbar
          actions={actions}
          aria-label="Workspace actions"
          overflowLabel="More workspace actions"
          overflowTestId="tb-overflow"
          data-testid="tb"
        />
      )
    )
  );
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

describe("computeToolbarLayout", () => {
  const input = { fullWidths: [119, 112, 28, 28], iconWidth: 28, gap: 4 };

  it("is full when the width is unknown", () => {
    expect(computeToolbarLayout({ ...input, available: null })).toEqual({
      mode: "full",
      visibleCount: 4,
      labelledCount: 4,
    });
  });

  it("keeps labels while they fit", () => {
    expect(computeToolbarLayout({ ...input, available: 299 }).mode).toBe("full");
  });

  it("collapses to icons when labels no longer fit", () => {
    // The leading label still fits: 119 + 3 × 28 + 3 × 4 = 215.
    expect(computeToolbarLayout({ ...input, available: 298 })).toEqual({
      mode: "icons",
      visibleCount: 4,
      labelledCount: 1,
    });
    expect(computeToolbarLayout({ ...input, available: 215 }).labelledCount).toBe(1);
    expect(computeToolbarLayout({ ...input, available: 214 }).labelledCount).toBe(0);
    expect(computeToolbarLayout({ ...input, available: 124 })).toEqual({
      mode: "icons",
      visibleCount: 4,
      labelledCount: 0,
    });
  });

  it("overflows the trailing actions when even the icons do not fit", () => {
    // 2 icons + overflow trigger = 3 × 28 + 2 × 4 = 92.
    expect(computeToolbarLayout({ ...input, available: 92 })).toEqual({
      mode: "overflow",
      visibleCount: 2,
      labelledCount: 0,
    });
    // Too narrow for anything but the trigger: everything is in the menu.
    expect(computeToolbarLayout({ ...input, available: 20 })).toEqual({
      mode: "overflow",
      visibleCount: 0,
      labelledCount: 0,
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

  it("collapses labels to icon-only buttons that keep their accessible name", () => {
    render();
    ro.resize(184);
    expect(layout()).toBe("icons");
    for (const name of [
      "New Workspace",
      "Save Current Layout",
      "Export Workspaces",
      "Import Workspaces",
    ]) {
      const btn = liveButton(name);
      expect(btn, name).not.toBeNull();
      expect(btn?.textContent).toBe("");
      expect(btn?.classList.contains("ui-btn--icon-only")).toBe(true);
    }
    // Test hooks survive the collapse.
    expect(container.querySelector('[data-testid="tb-save"]')).toBe(
      liveButton("Save Current Layout")
    );
    expect(container.querySelector('[data-testid="tb-overflow"]')).toBeNull();
  });

  it("moves the trailing actions into an overflow menu when even icons do not fit", () => {
    const onImport = vi.fn();
    render(makeActions({ import: onImport }));
    ro.resize(92);
    expect(layout()).toBe("overflow");
    expect(liveButton("New Workspace")).not.toBeNull();
    expect(liveButton("Save Current Layout")).not.toBeNull();
    expect(liveButton("Export Workspaces")).toBeNull();
    expect(liveButton("Import Workspaces")).toBeNull();
    const trigger = container.querySelector('[data-testid="tb-overflow"]');
    expect(trigger?.getAttribute("aria-label")).toBe("More workspace actions");

    openOverflow();
    expect(menuItemNames()).toEqual(["Export Workspaces", "Import Workspaces"]);
    const importItem = document.querySelector<HTMLElement>('[data-testid="tb-import"]');
    act(() => importItem?.click());
    expect(onImport).toHaveBeenCalledTimes(1);
  });

  it("keeps every action reachable by name at a very narrow width", () => {
    render();
    ro.resize(40);
    const inline = [
      "New Workspace",
      "Save Current Layout",
      "Export Workspaces",
      "Import Workspaces",
    ]
      .map(liveButton)
      .filter(Boolean);
    openOverflow();
    expect(inline.length + menuItemNames().length).toBe(4);
    expect(menuItemNames()).toContain("New Workspace");
  });

  it("keeps the leading action labelled while only it still fits", () => {
    render();
    ro.resize(244);
    expect(layout()).toBe("icons");
    expect(liveButton("New Workspace")?.textContent).toBe("New Workspace");
    expect(liveButton("Save Current Layout")?.textContent).toBe("");
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
