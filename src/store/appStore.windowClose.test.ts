import { describe, it, expect, beforeEach, vi } from "vitest";

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

// Untyped mocks so their call signatures accept any args and resolve per-test.
const openWindow = vi.fn();
const sendHandoffToWindow = vi.fn();
const closeTerminal = vi.fn();
const detachPersistentTab = vi.fn();

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  openWindow: (...args: unknown[]) => openWindow(...args),
  sendHandoffToWindow: (...args: unknown[]) => sendHandoffToWindow(...args),
  closeTerminal: (...args: unknown[]) => closeTerminal(...args),
  detachPersistentTab: (...args: unknown[]) => detachPersistentTab(...args),
}));

import { useAppStore } from "./appStore";
import type { WindowInfo } from "@/types/window";

/** Seed a live tab (with a backend session) and return its tab id. */
function seedLiveTab(opts: {
  title: string;
  connectionType: string;
  sessionId: string;
  persistentConnectionId?: string;
}): string {
  return useAppStore.getState().addTab(opts.title, opts.connectionType, undefined, {
    sessionId: opts.sessionId,
    ...(opts.persistentConnectionId
      ? { persistentConnectionId: opts.persistentConnectionId }
      : {}),
  });
}

const OTHERS: WindowInfo[] = [{ label: "win-1" }];

describe("appStore — close-with-live-tabs decision (#1903)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    openWindow.mockReset().mockResolvedValue("win-9");
    sendHandoffToWindow.mockReset().mockResolvedValue(undefined);
    closeTerminal.mockReset().mockResolvedValue(undefined);
    detachPersistentTab.mockReset().mockResolvedValue(undefined);
  });

  describe("prepareWindowClose", () => {
    it("proceeds with no dialog when the window has no live sessions", async () => {
      const decision = await useAppStore.getState().prepareWindowClose(OTHERS);
      expect(decision).toBe("proceed");
      expect(useAppStore.getState().pendingWindowClose).toBeNull();
    });

    it("detaches silently (no dialog) when every session is persistent", async () => {
      seedLiveTab({
        title: "server-1",
        connectionType: "ssh",
        sessionId: "s1",
        persistentConnectionId: "conn-1",
      });

      const decision = await useAppStore.getState().prepareWindowClose(OTHERS);

      expect(decision).toBe("proceed");
      expect(useAppStore.getState().pendingWindowClose).toBeNull();
      // Persistent session detached (kept running), never terminated.
      expect(detachPersistentTab).toHaveBeenCalledWith("s1", expect.any(String));
      expect(closeTerminal).not.toHaveBeenCalled();
    });

    it("raises the decision dialog when a non-persistent session would be lost", async () => {
      seedLiveTab({
        title: "server-1",
        connectionType: "ssh",
        sessionId: "s1",
        persistentConnectionId: "conn-1",
      });
      seedLiveTab({ title: "build", connectionType: "local", sessionId: "s2" });

      const decision = await useAppStore.getState().prepareWindowClose(OTHERS);

      expect(decision).toBe("prompt");
      const pending = useAppStore.getState().pendingWindowClose;
      expect(pending).not.toBeNull();
      expect(pending?.otherWindows).toEqual(OTHERS);
      const outcomes = pending?.sessions.map((s) => `${s.sessionId}:${s.outcome}`);
      expect(outcomes).toContain("s1:detach");
      expect(outcomes).toContain("s2:terminate");
      // No side effects yet — the user has not decided.
      expect(detachPersistentTab).not.toHaveBeenCalled();
      expect(closeTerminal).not.toHaveBeenCalled();
    });
  });

  describe("endWindowSessions", () => {
    it("detaches persistent sessions and terminates non-persistent ones", async () => {
      seedLiveTab({
        title: "server-1",
        connectionType: "ssh",
        sessionId: "s1",
        persistentConnectionId: "conn-1",
      });
      seedLiveTab({ title: "build", connectionType: "local", sessionId: "s2" });

      await useAppStore.getState().endWindowSessions();

      expect(detachPersistentTab).toHaveBeenCalledWith("s1", expect.any(String));
      expect(closeTerminal).toHaveBeenCalledWith("s2");
    });
  });

  describe("moveWindowSessionsToWindow", () => {
    it("hands every live session off to an existing window and marks them moving", async () => {
      seedLiveTab({ title: "server-1", connectionType: "ssh", sessionId: "s1" });
      seedLiveTab({ title: "build", connectionType: "local", sessionId: "s2" });

      await useAppStore
        .getState()
        .moveWindowSessionsToWindow({ kind: "existing", label: "win-1" });

      expect(sendHandoffToWindow).toHaveBeenCalledTimes(2);
      const targets = sendHandoffToWindow.mock.calls.map((c) => c[0]);
      expect(targets).toEqual(["win-1", "win-1"]);
      // Both sessions are flagged moving so the source Terminals do not tear
      // them down on unmount.
      expect(useAppStore.getState().movingSessionIds).toEqual(
        expect.arrayContaining(["s1", "s2"])
      );
      expect(openWindow).not.toHaveBeenCalled();
    });

    it("creates a new window seeded with the first tab when target is new", async () => {
      seedLiveTab({ title: "server-1", connectionType: "ssh", sessionId: "s1" });
      seedLiveTab({ title: "build", connectionType: "local", sessionId: "s2" });

      await useAppStore.getState().moveWindowSessionsToWindow({ kind: "new" });

      expect(openWindow).toHaveBeenCalledTimes(1);
      // First tab seeds the new window; the remaining tab is queued to it.
      expect(sendHandoffToWindow).toHaveBeenCalledTimes(1);
      expect(sendHandoffToWindow.mock.calls[0][0]).toBe("win-9");
    });
  });
});
