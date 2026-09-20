import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Tab } from "./Tab";
import { TooltipProvider } from "@/components/ui";
import { TerminalTab } from "@/types/terminal";

// Stub the dnd-kit sortable wrapper so the Tab mounts without a DndContext.
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
    title: "server-1",
    connectionType: "ssh",
    contentType: "terminal",
    config: { type: "ssh", config: {} },
    panelId: PANEL_ID,
    isActive: true,
    ...overrides,
  };
}

function renderTab(
  tab: TerminalTab,
  controlledByWindow: { label: string; name: string } | null,
  onFocusOwningWindow?: (label: string) => void
) {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <Tab
          tab={tab}
          onActivate={() => {}}
          onClose={() => {}}
          controlledByWindow={controlledByWindow}
          onFocusOwningWindow={onFocusOwningWindow}
        />
      </TooltipProvider>
    );
  });
  return root;
}

describe("Tab — controlled-by-another-window badge (#2872)", () => {
  let root: Root | null = null;

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    document.body.innerHTML = "";
  });

  it("renders the badge for a session controlled by another window", () => {
    root = renderTab(makeTab(), { label: "win-2", name: "Window 2" });
    const badge = document.querySelector('[data-testid="tab-controlled-badge-t1"]');
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute("aria-label")).toContain("Window 2");
  });

  it("does not render the badge when this window controls the session", () => {
    root = renderTab(makeTab(), null);
    expect(document.querySelector(".tab__controlled-badge")).toBeNull();
  });

  it("shows the badge even when the tab is inactive", () => {
    root = renderTab(makeTab({ isActive: false }), { label: "win-2", name: "Window 2" });
    expect(document.querySelector(".tab__controlled-badge")).not.toBeNull();
  });

  it("focuses the owning window (not the tab) when the badge is clicked", () => {
    const onActivate = vi.fn();
    const onFocus = vi.fn();
    root = createRoot(document.body.appendChild(document.createElement("div")));
    act(() => {
      root!.render(
        <TooltipProvider delayDuration={0}>
          <Tab
            tab={makeTab()}
            onActivate={onActivate}
            onClose={() => {}}
            controlledByWindow={{ label: "win-2", name: "Window 2" }}
            onFocusOwningWindow={onFocus}
          />
        </TooltipProvider>
      );
    });
    const badge = document.querySelector<HTMLButtonElement>(
      '[data-testid="tab-controlled-badge-t1"]'
    );
    act(() => {
      badge?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onFocus).toHaveBeenCalledWith("win-2");
    // Clicking the badge must not also activate the tab (stopPropagation).
    expect(onActivate).not.toHaveBeenCalled();
  });
});
