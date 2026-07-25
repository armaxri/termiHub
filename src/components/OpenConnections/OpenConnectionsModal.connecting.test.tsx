/**
 * Tests for the "Connecting" section of the Open Connections panel (#952):
 * sessions still establishing their handshake are listed and can be cancelled,
 * which aborts the in-flight connect via cancel_connecting.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import type { TerminalTab } from "@/types/terminal";

const cancelConnecting = vi.fn((_id: string) => Promise.resolve(true));
vi.mock("@/services/api", () => ({
  listSessionOwners: vi.fn(() => Promise.resolve({})),
  focusWindow: vi.fn(() => Promise.resolve()),
  listLocalSessions: vi.fn(() => Promise.resolve([])),
  listAgentSessions: vi.fn(() => Promise.resolve([])),
  closeTerminal: vi.fn(() => Promise.resolve()),
  closeAgentSession: vi.fn(() => Promise.resolve()),
  cancelConnecting: (id: string) => cancelConnecting(id),
  xServerStatus: vi.fn(() =>
    Promise.resolve({ state: "absent", platform: "linux", managed: false, sessionCount: 0 })
  ),
  xServerStop: vi.fn(() => Promise.resolve()),
}));

import { OpenConnectionsModal } from "./OpenConnectionsModal";

function connectingTab(id: string, title: string, panelId: string): TerminalTab {
  return {
    id,
    sessionId: null,
    title,
    connectionType: "ssh",
    contentType: "terminal",
    config: { type: "ssh", config: {} },
    panelId,
    isActive: true,
  };
}

describe("OpenConnectionsModal — Connecting section", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    cancelConnecting.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderWithConnectingTab() {
    const leafId = useAppStore.getState().rootPanel.id;
    const tab = connectingTab("tab-1", "app-server", leafId);
    useAppStore.setState({
      rootPanel: { type: "leaf", id: leafId, tabs: [tab], activeTabId: tab.id },
      activePanelId: leafId,
      terminalConnecting: { "tab-1": true },
    });
    act(() => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <OpenConnectionsModal open={true} onOpenChange={() => {}} />
        </TooltipProvider>
      );
    });
  }

  it("lists a connecting session and cancels it via cancel_connecting", () => {
    renderWithConnectingTab();

    // Section + row render (the modal portals to document.body).
    const rows = Array.from(document.querySelectorAll(".oc-row")).filter((r) =>
      r.querySelector(".oc-row__title")?.textContent?.includes("app-server")
    );
    expect(rows).toHaveLength(1);

    const killBtn = rows[0].querySelector(".oc-row__kill") as HTMLButtonElement;
    expect(killBtn).not.toBeNull();
    // Kill is now the shared Button primitive (retains .oc-row__kill as a hook).
    expect(killBtn.classList.contains("ui-btn")).toBe(true);
    act(() => killBtn.click());

    expect(cancelConnecting).toHaveBeenCalledWith("tab-1");
  });

  it("renders through the shared Modal primitive", () => {
    renderWithConnectingTab();
    const modal = document.querySelector(".ui-modal");
    expect(modal).not.toBeNull();
    expect(modal?.querySelector(".ui-modal__title")?.textContent).toContain("Open Connections");
  });

  it("shows no Connecting section when nothing is connecting", () => {
    act(() => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <OpenConnectionsModal open={true} onOpenChange={() => {}} />
        </TooltipProvider>
      );
    });
    const titles = Array.from(document.querySelectorAll(".oc-section__title")).map(
      (t) => t.textContent
    );
    expect(titles).not.toContain("Connecting");
  });
});
