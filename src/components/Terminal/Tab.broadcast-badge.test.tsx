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

function renderTab(tab: TerminalTab, isBroadcast: boolean) {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <Tab tab={tab} onActivate={() => {}} onClose={() => {}} isBroadcast={isBroadcast} />
      </TooltipProvider>
    );
  });
  return root;
}

describe("Tab — broadcast badge (#1957)", () => {
  let root: Root | null = null;

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    document.body.innerHTML = "";
  });

  it("renders the Radio badge for a participating tab", () => {
    root = renderTab(makeTab(), true);
    expect(document.querySelector(".tab__broadcast-badge")).not.toBeNull();
    expect(document.querySelector('[data-testid="tab-broadcast-badge-t1"]')).not.toBeNull();
  });

  it("does not render the badge for a non-participating tab", () => {
    root = renderTab(makeTab(), false);
    expect(document.querySelector(".tab__broadcast-badge")).toBeNull();
  });

  it("shows the badge even when the tab is inactive", () => {
    root = renderTab(makeTab({ isActive: false }), true);
    expect(document.querySelector(".tab__broadcast-badge")).not.toBeNull();
  });
});
