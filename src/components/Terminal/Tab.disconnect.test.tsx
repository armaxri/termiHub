/**
 * Tests for the explicit "Disconnect" tab context-menu command (UX-015).
 *
 * A terminal tab holding a live session gains a "Disconnect" item that drops the
 * backend connection while keeping the tab open (distinct from Close). The item
 * is present only when an `onDisconnect` handler is supplied (i.e. the tab has a
 * live session to drop) and is absent otherwise.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Tab } from "./Tab";
import { TooltipProvider } from "@/components/ui";
import { TerminalTab } from "@/types/terminal";

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

function renderTab(opts: { tab?: TerminalTab; onDisconnect?: () => void } = {}) {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <Tab
          tab={opts.tab ?? makeTab()}
          onActivate={() => {}}
          onClose={() => {}}
          onDisconnect={opts.onDisconnect}
        />
      </TooltipProvider>
    );
  });
  return root;
}

function openMenu() {
  const trigger = document.querySelector('[data-testid="tab-t1"]');
  act(() => {
    trigger!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  });
}

describe("Tab — Disconnect command (UX-015)", () => {
  let root: Root | null = null;

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    document.body.innerHTML = "";
  });

  it("shows 'Disconnect' when a live session can be dropped", () => {
    root = renderTab({ onDisconnect: () => {} });
    openMenu();
    expect(document.querySelector('[data-testid="tab-context-disconnect"]')).not.toBeNull();
  });

  it("invokes onDisconnect when 'Disconnect' is picked", () => {
    const onDisconnect = vi.fn();
    root = renderTab({ onDisconnect });
    openMenu();
    const item = document.querySelector('[data-testid="tab-context-disconnect"]') as HTMLElement;
    act(() => item.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onDisconnect).toHaveBeenCalledOnce();
  });

  it("hides 'Disconnect' when there is no live session to drop", () => {
    root = renderTab({ onDisconnect: undefined });
    openMenu();
    expect(document.querySelector('[data-testid="tab-context-disconnect"]')).toBeNull();
    // The rest of the terminal context menu is still present.
    expect(document.querySelector('[data-testid="tab-context-rename"]')).not.toBeNull();
  });
});
