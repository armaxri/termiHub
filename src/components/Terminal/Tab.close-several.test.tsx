/**
 * The tab's own close-several and rename gestures (#6161).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
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

function renderTab(props: Partial<React.ComponentProps<typeof Tab>> = {}) {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <Tab tab={makeTab()} onActivate={() => {}} onClose={() => {}} {...props} />
      </TooltipProvider>
    );
  });
  return root;
}

const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

function openMenu() {
  act(() => {
    q("tab-t1")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  });
}

describe("Tab — close others, close to the right, double-click rename (#6161)", () => {
  let root: Root | null = null;

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    document.body.innerHTML = "";
  });

  it("offers Close others and Close tabs to the right, and runs them", () => {
    const onCloseOthers = vi.fn();
    const onCloseToRight = vi.fn();
    root = renderTab({ onCloseOthers, onCloseToRight });
    openMenu();
    expect(q("tab-context-close-others")?.textContent).toContain("Close others");
    expect(q("tab-context-close-right")?.textContent).toContain("Close tabs to the right");
    act(() =>
      q("tab-context-close-others")!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );
    expect(onCloseOthers).toHaveBeenCalledOnce();
    openMenu();
    act(() =>
      q("tab-context-close-right")!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );
    expect(onCloseToRight).toHaveBeenCalledOnce();
  });

  it("leaves them out when there is nothing to close", () => {
    root = renderTab({});
    openMenu();
    expect(q("tab-context-close-others")).toBeNull();
    expect(q("tab-context-close-right")).toBeNull();
  });

  it("renames on a double-click", () => {
    const onRename = vi.fn();
    root = renderTab({ onRename });
    act(() => q("tab-t1")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(onRename).toHaveBeenCalledOnce();
  });
});
