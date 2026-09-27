/**
 * Non-terminal tab icon hook (#3693).
 *
 * A Settings tab dragged between panels must keep its gear icon (MT-UI-10). The
 * system harness checks that through `tab-icon-<tabId>`, whose lucide class names
 * the icon; this pins the test id and the class the harness reads.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
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

function settingsTab(): TerminalTab {
  return {
    id: "settings-1",
    sessionId: null,
    title: "Settings",
    connectionType: "local",
    contentType: "settings",
    config: { type: "local", config: { shell: "zsh" } },
    panelId: "panel-1",
    isActive: true,
  };
}

describe("Tab icon test id (#3693)", () => {
  let root: Root | null = null;

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    document.body.innerHTML = "";
  });

  it("renders the Settings gear under tab-icon-<tabId>", () => {
    root = createRoot(document.body.appendChild(document.createElement("div")));
    act(() => {
      root!.render(
        <TooltipProvider delayDuration={0}>
          <Tab tab={settingsTab()} onActivate={() => {}} onClose={() => {}} />
        </TooltipProvider>
      );
    });

    const icon = document.querySelector('[data-testid="tab-icon-settings-1"]');
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("class")).toContain("lucide-settings");
  });
});
