/**
 * Tests for the "Move to Window" tab context-menu commands (#1901).
 *
 * Covers that a session tab's context menu exposes "Move to New Window" and,
 * when other windows exist, a "Move to Window ▸" submenu, and that picking an
 * entry invokes the matching move handler with the right target.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Tab } from "./Tab";
import { TooltipProvider } from "@/components/ui";
import { TerminalTab } from "@/types/terminal";
import type { WindowInfo } from "@/types/window";

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));

const PANEL_ID = "panel-1";

function makeTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: "t1",
    sessionId: "sess-1",
    title: "bash",
    connectionType: "local",
    contentType: "terminal",
    config: { type: "local", config: {} },
    panelId: PANEL_ID,
    isActive: true,
    ...overrides,
  };
}

interface RenderOpts {
  tab?: TerminalTab;
  windows?: WindowInfo[];
  currentWindowLabel?: string | null;
  onMoveToNewWindow?: () => void;
  onMoveToWindow?: (label: string) => void;
}

function renderTab(opts: RenderOpts = {}) {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <Tab
          tab={opts.tab ?? makeTab()}
          onActivate={() => {}}
          onClose={() => {}}
          windows={opts.windows ?? []}
          currentWindowLabel={opts.currentWindowLabel ?? "main"}
          onMoveToNewWindow={opts.onMoveToNewWindow}
          onMoveToWindow={opts.onMoveToWindow}
        />
      </TooltipProvider>
    );
  });
  return root;
}

/** Open the tab's context menu by dispatching a contextmenu event. */
function openMenu() {
  const trigger = document.querySelector('[data-testid="tab-t1"]');
  act(() => {
    trigger!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  });
}

describe("Tab — Move to Window commands (#1901)", () => {
  let root: Root | null = null;

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    document.body.innerHTML = "";
  });

  it("shows 'Move to New Window' in a session tab's context menu", () => {
    root = renderTab();
    openMenu();
    expect(document.querySelector('[data-testid="tab-context-move-new-window"]')).not.toBeNull();
  });

  it("invokes onMoveToNewWindow when 'Move to New Window' is picked", () => {
    const onMoveToNewWindow = vi.fn();
    root = renderTab({ onMoveToNewWindow });
    openMenu();
    const item = document.querySelector(
      '[data-testid="tab-context-move-new-window"]'
    ) as HTMLElement;
    act(() => item.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onMoveToNewWindow).toHaveBeenCalledOnce();
  });

  it("hides the 'Move to Window ▸' submenu when only the current window exists", () => {
    root = renderTab({ windows: [{ label: "main" }], currentWindowLabel: "main" });
    openMenu();
    expect(document.querySelector('[data-testid="tab-context-move-window"]')).toBeNull();
    // The direct tear-out command is still present.
    expect(document.querySelector('[data-testid="tab-context-move-new-window"]')).not.toBeNull();
  });

  it("shows the 'Move to Window ▸' submenu trigger once another window exists", () => {
    root = renderTab({
      windows: [{ label: "main" }, { label: "win-1" }],
      currentWindowLabel: "main",
    });
    openMenu();
    expect(document.querySelector('[data-testid="tab-context-move-window"]')).not.toBeNull();
  });

  it("does not add Move commands to a non-session (settings) tab", () => {
    root = renderTab({
      tab: makeTab({ contentType: "settings", sessionId: null }),
      windows: [{ label: "main" }, { label: "win-1" }],
    });
    openMenu();
    expect(document.querySelector('[data-testid="tab-context-move-new-window"]')).toBeNull();
    expect(document.querySelector('[data-testid="tab-context-move-window"]')).toBeNull();
  });
});
