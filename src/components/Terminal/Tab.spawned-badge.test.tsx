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
    title: "Container: alpine:3 (Spawned)",
    connectionType: "docker",
    contentType: "terminal",
    config: { type: "docker", config: {} },
    panelId: PANEL_ID,
    isActive: true,
    ...overrides,
  };
}

function renderTab(tab: TerminalTab) {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <Tab tab={tab} onActivate={() => {}} onClose={() => {}} />
      </TooltipProvider>
    );
  });
  return root;
}

describe("Tab — Spawned badge (#1446)", () => {
  let root: Root | null = null;

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    document.body.innerHTML = "";
  });

  it("renders a Spawned badge for a spawned tab", () => {
    root = renderTab(makeTab({ spawned: true }));
    const badge = document.querySelector(".tab__spawned-badge");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain("Spawned");
  });

  it("does not render the badge for a regular tab", () => {
    root = renderTab(makeTab({ spawned: false }));
    expect(document.querySelector(".tab__spawned-badge")).toBeNull();
  });
});
