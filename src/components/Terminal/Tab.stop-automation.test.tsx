/**
 * The tab context menu's "Stop automation" (#5818, slice 5): the keyboard
 * route to the running-automation badge's Stop, shown only while an
 * automation is typing into the tab.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Tab } from "./Tab";
import { TooltipProvider } from "@/components/ui";
import type { TerminalTab } from "@/types/terminal";
import type { RunningAutomationInfo } from "@/utils/automationTabBadge";

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

const tab: TerminalTab = {
  id: "t1",
  sessionId: "sess-1",
  title: "bash",
  connectionType: "local",
  contentType: "terminal",
  config: { type: "local", config: {} },
  panelId: "panel-1",
  isActive: true,
};

const running: RunningAutomationInfo = {
  name: "Deploy",
  completed: 1,
  total: 3,
  stop: { kind: "macro" },
};

let root: Root | null = null;

function renderTab(info: RunningAutomationInfo | null, onStop: () => void) {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => {
    root!.render(
      <TooltipProvider delayDuration={0}>
        <Tab
          tab={tab}
          onActivate={() => {}}
          onClose={() => {}}
          runningAutomation={info}
          onStopAutomation={onStop}
        />
      </TooltipProvider>
    );
  });
  act(() => {
    document
      .querySelector('[data-testid="tab-t1"]')!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  });
}

const item = () =>
  document.querySelector('[data-testid="tab-context-stop-automation"]') as HTMLElement | null;

describe("Tab — Stop automation (#5818)", () => {
  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    document.body.innerHTML = "";
  });

  it("stops the running automation from the context menu", () => {
    const onStop = vi.fn();
    renderTab(running, onStop);
    expect(item()?.textContent).toContain("Stop automation");
    act(() => item()!.click());
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("is absent while nothing runs on the tab", () => {
    renderTab(null, vi.fn());
    expect(item()).toBeNull();
  });
});
