import { describe, it, expect, beforeEach, vi } from "vitest";

// Explicit user "Disconnect" (UX-015): drop a tab's live backend connection while
// keeping the tab open in a reconnectable state — distinct from closing the tab,
// which tears it down and loses the scrollback. These tests assert the store
// action drops the session (via the intentional-kill path) and never removes the
// tab, and that the follow-on exit event lands the tab in the reconnectable view
// mode. The service mocks only satisfy module import + record the drop call.

const closeTerminalMock = vi.fn((..._args: unknown[]) => Promise.resolve());
const detachPersistentTabMock = vi.fn((..._args: unknown[]) => Promise.resolve());

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  persistConnection: vi.fn(() => Promise.resolve()),
  removeConnection: vi.fn(() => Promise.resolve()),
  persistFolder: vi.fn(() => Promise.resolve()),
  removeFolder: vi.fn(() => Promise.resolve()),
  getSettings: vi.fn(() =>
    Promise.resolve({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: true,
    })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  moveConnectionToFile: vi.fn(() => Promise.resolve()),
  reloadExternalConnections: vi.fn(() => Promise.resolve([])),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/services/api", () => ({
  closeTerminal: (...args: unknown[]) => closeTerminalMock(...args),
  detachPersistentTab: (...args: unknown[]) => detachPersistentTabMock(...args),
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
}));

import { useAppStore } from "./appStore";
import { layoutState } from "@/test/layoutState";
import { getAllLeaves } from "@/utils/panelTree";

/** All live tab ids across the composed layout, so a test can assert survival. */
function liveTabIds(): string[] {
  return getAllLeaves(layoutState().rootPanel).flatMap((leaf) => leaf.tabs.map((t) => t.id));
}

/** Open a terminal tab already carrying a live backend session id. */
function makeLiveTerminalTab(sessionId: string, persistentConnectionId?: string): string {
  return useAppStore.getState().addTab(
    "shell",
    "local",
    { type: "local", config: {} },
    { contentType: "terminal", sessionId, persistentConnectionId }
  );
}

describe("disconnectTerminal (UX-015)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    closeTerminalMock.mockClear();
    detachPersistentTabMock.mockClear();
  });

  it("drops the backend session but keeps the tab open", () => {
    const tabId = makeLiveTerminalTab("sess-1");

    useAppStore.getState().disconnectTerminal(tabId);

    // The backend connection is dropped as an intentional close…
    expect(closeTerminalMock).toHaveBeenCalledWith("sess-1", true);
    // …tagged as an intentional kill so the exit handler folds it as a user
    // disconnect (view mode + Reconnect), not an unexpected drop.
    expect(useAppStore.getState().intentionallyKilledSessions["sess-1"]).toBe(true);
    // …and the tab itself is NOT torn down (unlike closeTab).
    expect(liveTabIds()).toContain(tabId);
  });

  it("leaves the tab in a reconnectable view-mode state once the session exits", () => {
    const tabId = makeLiveTerminalTab("sess-1");

    useAppStore.getState().disconnectTerminal(tabId);
    // The terminal-exit event fires next, classified as a user kill because the
    // session was tagged. That drives the tab into view mode: scrollback is kept
    // and the Reconnect banner is offered.
    useAppStore.getState().setTerminalExited(tabId, { code: null, reason: "killed" });

    expect(useAppStore.getState().terminalViewMode[tabId]).toBe(true);
    expect(liveTabIds()).toContain(tabId);
  });

  it("detaches a persistent tab instead of killing its daemon session", () => {
    const tabId = makeLiveTerminalTab("sess-1", "persist-1");

    useAppStore.getState().disconnectTerminal(tabId);

    // A persistent daemon-backed session is detached (kept running to re-attach),
    // never force-closed.
    expect(detachPersistentTabMock).toHaveBeenCalledWith("sess-1", tabId);
    expect(closeTerminalMock).not.toHaveBeenCalled();
    expect(liveTabIds()).toContain(tabId);
  });

  it("is a no-op for a tab with no live session", () => {
    const noSessionTab = useAppStore.getState().addTab(
      "shell",
      "local",
      { type: "local", config: {} },
      { contentType: "terminal", sessionId: null }
    );

    useAppStore.getState().disconnectTerminal(noSessionTab);

    expect(closeTerminalMock).not.toHaveBeenCalled();
    expect(detachPersistentTabMock).not.toHaveBeenCalled();
    expect(liveTabIds()).toContain(noSessionTab);
  });
});
