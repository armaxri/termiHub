/**
 * Branch coverage for the window-management slice (#2979): hand-off draining
 * without a session / with a failed claim, the per-window layout report and its
 * debounce (held while a restore settles), and the single-session detach toast
 * on window close.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const m = vi.hoisted(() => ({
  claimSession: vi.fn(),
  takePendingHandoffs: vi.fn(),
  reportWindowLayout: vi.fn(),
  detachPersistentTab: vi.fn(),
  closeTerminal: vi.fn(),
  frontendLog: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  getSettings: vi.fn(() => Promise.resolve({ version: "1", externalConnectionFiles: [] })),
  saveSettings: vi.fn(() => Promise.resolve()),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/services/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api")>()),
  claimSession: (...a: unknown[]) => m.claimSession(...a),
  takePendingHandoffs: () => m.takePendingHandoffs(),
  reportWindowLayout: (...a: unknown[]) => m.reportWindowLayout(...a),
  detachPersistentTab: (...a: unknown[]) => m.detachPersistentTab(...a),
  closeTerminal: (...a: unknown[]) => m.closeTerminal(...a),
  listSessionOwners: vi.fn(() => Promise.resolve({})),
}));

vi.mock("@/utils/frontendLog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/frontendLog")>()),
  frontendLog: (...a: unknown[]) => m.frontendLog(...a),
}));

vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return { ...actual, toast: { ...actual.toast, success: m.toastSuccess } };
});

import { useAppStore } from "./appStore";
import { LAST_SESSION_SAVE_DEBOUNCE_MS } from "./restoreHelpers";
import { layoutState } from "@/test/layoutState";
import { getAllLeaves } from "@/utils/panelTree";
import type { TabHandoffRecord } from "@/types/window";

function handoff(sessionId: string | null, title: string): TabHandoffRecord {
  return {
    tab: {
      sessionId,
      title,
      connectionType: "local",
      contentType: "terminal",
      config: { type: "local", config: {} },
    },
  };
}

describe("windowManagementSlice — branch coverage (#2979)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    for (const fn of Object.values(m)) fn.mockReset();
    m.claimSession.mockResolvedValue(null);
    m.takePendingHandoffs.mockResolvedValue([]);
    m.reportWindowLayout.mockResolvedValue(undefined);
    m.detachPersistentTab.mockResolvedValue(undefined);
    m.closeTerminal.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("receivePendingHandoffs", () => {
    it("hydrates a session-less record without claiming anything", async () => {
      m.takePendingHandoffs.mockResolvedValue([handoff(null, "fresh")]);

      await useAppStore.getState().receivePendingHandoffs();

      expect(m.claimSession).not.toHaveBeenCalled();
      const tabs = getAllLeaves(layoutState().rootPanel).flatMap((l) => l.tabs);
      expect(tabs.map((t) => t.title)).toEqual(["fresh"]);
    });

    it("still hydrates the tab when claiming its session fails", async () => {
      m.takePendingHandoffs.mockResolvedValue([handoff("s1", "moved")]);
      m.claimSession.mockRejectedValue(new Error("owned elsewhere"));

      await useAppStore.getState().receivePendingHandoffs();

      expect(m.frontendLog).toHaveBeenCalledWith(
        "multi_window",
        "claimSession failed: Error: owned elsewhere"
      );
      const tabs = getAllLeaves(layoutState().rootPanel).flatMap((l) => l.tabs);
      expect(tabs.map((t) => t.sessionId)).toEqual(["s1"]);
    });
  });

  describe("reportOwnWindowLayout", () => {
    it("reports the captured groups with the active group's index", async () => {
      useAppStore.getState().addTab("bash", "local");
      useAppStore.getState().addTabGroup("Second");

      await useAppStore.getState().reportOwnWindowLayout();

      expect(m.reportWindowLayout).toHaveBeenCalledTimes(1);
      const [groups, activeIndex] = m.reportWindowLayout.mock.calls[0];
      expect(groups).toHaveLength(2);
      expect(activeIndex).toBe(1);
    });

    it("logs a failed report instead of throwing", async () => {
      m.reportWindowLayout.mockRejectedValue(new Error("main window gone"));

      await expect(useAppStore.getState().reportOwnWindowLayout()).resolves.toBeUndefined();

      expect(m.frontendLog).toHaveBeenCalledWith(
        "multi_window",
        "reportWindowLayout failed: Error: main window gone"
      );
    });
  });

  describe("scheduleWindowLayoutReport", () => {
    it("debounces bursts into a single report", async () => {
      vi.useFakeTimers();
      useAppStore.getState().scheduleWindowLayoutReport();
      useAppStore.getState().scheduleWindowLayoutReport();

      await vi.advanceTimersByTimeAsync(LAST_SESSION_SAVE_DEBOUNCE_MS - 1);
      expect(m.reportWindowLayout).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(m.reportWindowLayout).toHaveBeenCalledTimes(1);
    });

    it("holds the report while a restore is still settling", async () => {
      vi.useFakeTimers();
      useAppStore.setState({ restoreInProgress: true });

      useAppStore.getState().scheduleWindowLayoutReport();
      await vi.advanceTimersByTimeAsync(LAST_SESSION_SAVE_DEBOUNCE_MS * 2);

      expect(m.reportWindowLayout).not.toHaveBeenCalled();
    });
  });

  describe("prepareWindowClose", () => {
    it("detaches a single persistent session with a singular toast", async () => {
      useAppStore.getState().addTab("bash", "local");
      const tab = getAllLeaves(layoutState().rootPanel)[0].tabs[0];
      useAppStore.getState().setTabSessionId(tab.id, "sess-p");
      useAppStore.setState((s) => ({
        tabContent: {
          ...s.tabContent,
          [tab.id]: { ...s.tabContent[tab.id], persistentConnectionId: "pc-1" },
        },
      }));

      const decision = await useAppStore.getState().prepareWindowClose([]);

      expect(decision).toBe("proceed");
      expect(m.detachPersistentTab).toHaveBeenCalledWith("sess-p", tab.id);
      expect(m.toastSuccess).toHaveBeenCalledWith("1 session detached — still running");
    });
  });
});
