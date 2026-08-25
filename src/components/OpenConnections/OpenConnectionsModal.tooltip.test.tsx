/**
 * Verifies the Open Connections panel adopts the shared `Tooltip` primitive for
 * its section bulk-action control (issue #1114, follow-up to #1102).
 *
 * The per-section "Kill All" button previously carried a bare `title=` giving
 * the section-specific action ("Kill All Local Sessions"). That help must now
 * come from the shared Tooltip: the button must no longer expose a bare title,
 * and focusing it must wire `aria-describedby` to the Radix tooltip. The
 * truncation `title=` on non-interactive connection-name spans is intentionally
 * left in place and is not asserted against here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import type { TerminalTab } from "@/types/terminal";
import {
  connecting,
  flushSessionRegion,
  installSessionLifecycleHarness,
} from "@/test/sessionLifecycleRegionTestHarness";

vi.mock("@/services/api", () => ({
  listSessionOwners: vi.fn(() => Promise.resolve({})),
  focusWindow: vi.fn(() => Promise.resolve()),
  listLocalSessions: vi.fn(() => Promise.resolve([])),
  listAgentSessions: vi.fn(() => Promise.resolve([])),
  closeTerminal: vi.fn(() => Promise.resolve()),
  closeAgentSession: vi.fn(() => Promise.resolve()),
  cancelConnecting: vi.fn(() => Promise.resolve(true)),
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

let container: HTMLDivElement;
let root: Root;

// The Connecting section (which carries the Kill All control under test) is
// derived from the projected `session-lifecycle` region (#2205), so seed a
// `connecting` session there rather than the removed `appStore.terminalConnecting`.
const harness = installSessionLifecycleHarness();

async function renderWithSection() {
  const leafId = useAppStore.getState().rootPanel.id;
  const tab = connectingTab("tab-1", "app-server", leafId);
  useAppStore.setState({
    rootPanel: { type: "leaf", id: leafId, tabs: [tab], activeTabId: tab.id },
    activePanelId: leafId,
  });
  harness.transport.setSession("tab-1", connecting());
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <OpenConnectionsModal open={true} onOpenChange={() => {}} />
      </TooltipProvider>
    );
  });
  await flushSessionRegion();
}

describe("OpenConnectionsModal — tooltip adoption (#1114)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("does not leave a bare title on the section Kill All control", async () => {
    await renderWithSection();
    const killAll = document.querySelector<HTMLButtonElement>(".oc-section__kill-all");
    expect(killAll).not.toBeNull();
    expect(killAll?.getAttribute("title")).toBeNull();
  });

  it("wires the section Kill All control to its tooltip via aria-describedby on focus", async () => {
    await renderWithSection();
    const killAll = document.querySelector<HTMLButtonElement>(".oc-section__kill-all")!;
    act(() => {
      killAll.focus();
      killAll.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
    });
    expect(killAll.getAttribute("aria-describedby")).toBeTruthy();
  });
});
