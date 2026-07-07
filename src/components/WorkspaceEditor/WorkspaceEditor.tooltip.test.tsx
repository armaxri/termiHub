/**
 * Verifies the workspace layout designer icon buttons adopt the shared
 * `Tooltip` primitive (issue #1160, follow-up to #1114).
 *
 * A tooltip is not an accessible name, so each converted icon button must keep
 * an `aria-label`, must no longer carry a bare `title`, and the Radix tooltip
 * trigger must wire `aria-describedby` when focused. The stable `data-testid`s
 * must survive the migration.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { LayoutDesigner } from "./LayoutDesigner";
import { withTooltip } from "@/test/tooltip";
import type { WorkspaceLayoutNode, WorkspaceTabDef } from "@/types/workspace";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(vi.fn()),
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(),
}));

function tab(ref?: string): WorkspaceTabDef {
  return { connectionRef: ref };
}

function leaf(...tabs: WorkspaceTabDef[]): WorkspaceLayoutNode {
  return { type: "leaf", tabs };
}

function hsplit(...children: WorkspaceLayoutNode[]): WorkspaceLayoutNode {
  return { type: "split", direction: "horizontal", children };
}

const noop = () => {};

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function render(layout: WorkspaceLayoutNode): void {
  act(() => {
    root.render(withTooltip(<LayoutDesigner layout={layout} onChange={noop} />));
  });
}

describe("LayoutDesigner — tooltip adoption (#1160)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("exposes accessible names via aria-label without a bare title on leaf icons", async () => {
    render(hsplit(leaf(tab("a"), tab("b")), leaf(tab("c"))));
    await flush();

    const ids = [
      "layout-leaf-split-h-0",
      "layout-leaf-split-v-0",
      "layout-leaf-add-tab-0",
      "layout-remove-leaf-0",
      "layout-remove-tab-0-0",
    ];
    for (const id of ids) {
      const btn = container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
      expect(btn).not.toBeNull();
      expect(btn?.getAttribute("aria-label")).toBeTruthy();
      expect(btn?.getAttribute("title")).toBeNull();
    }
  });

  it("exposes an accessible name without a bare title on the size-reset control", async () => {
    // A split with custom sizes surfaces the reset-to-equal button.
    const layout: WorkspaceLayoutNode = {
      type: "split",
      direction: "horizontal",
      sizes: [70, 30],
      children: [leaf(tab("a")), leaf(tab("b"))],
    };
    render(layout);
    await flush();

    const reset = container.querySelector<HTMLButtonElement>('[data-testid="layout-size-reset"]');
    expect(reset).not.toBeNull();
    expect(reset?.getAttribute("aria-label")).toBeTruthy();
    expect(reset?.getAttribute("title")).toBeNull();
  });

  it("wires an icon button to its tooltip via aria-describedby on focus", async () => {
    render(leaf(tab("a")));
    await flush();

    const add = container.querySelector<HTMLButtonElement>(
      '[data-testid="layout-leaf-add-tab-0"]'
    )!;
    act(() => {
      add.focus();
      add.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
    });

    expect(add.getAttribute("aria-describedby")).toBeTruthy();
  });
});
