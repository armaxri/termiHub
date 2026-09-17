import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { create, type StateCreator } from "zustand";

import type { MonitoringEntry } from "@/types/monitoring";
import { onFrontendLog } from "@/utils/frontendLog";

vi.mock("@/services/api", () => ({
  sessionMonitoringOpen: vi.fn(() => Promise.resolve()),
  sessionMonitoringClose: vi.fn(() => Promise.resolve()),
  sessionMonitoringSetPaused: vi.fn(() => Promise.resolve()),
  sessionMonitoringSetInterval: vi.fn(() => Promise.resolve()),
  sessionMonitoringCancel: vi.fn(() => Promise.resolve()),
}));

const monitorsView = { monitors: {} as Record<string, MonitoringEntry> };
vi.mock("@/store/systemMonitorBridge", () => ({
  currentMonitorsView: vi.fn(() => monitorsView),
  dispatchMonitorIntentBestEffort: vi.fn(),
  ensureMonitorsSubscribed: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/store/runLocationStore", () => ({
  useRunLocationStore: { getState: () => ({ systemMonitorLocations: {} }) },
}));

import {
  sessionMonitoringCancel,
  sessionMonitoringClose,
  sessionMonitoringSetPaused,
} from "@/services/api";
import { dispatchMonitorIntentBestEffort } from "@/store/systemMonitorBridge";
import { createMonitoringSlice, type MonitoringSlice } from "./monitoringSlice";

const mockedCancel = vi.mocked(sessionMonitoringCancel);
const mockedClose = vi.mocked(sessionMonitoringClose);
const mockedSetPaused = vi.mocked(sessionMonitoringSetPaused);
const mockedDispatch = vi.mocked(dispatchMonitorIntentBestEffort);

const makeStore = () =>
  create<MonitoringSlice>()(createMonitoringSlice as unknown as StateCreator<MonitoringSlice>);

const entry = (over: Partial<MonitoringEntry> = {}): MonitoringEntry =>
  ({
    key: "sess-a",
    host: "host",
    monitorSessionId: null,
    stats: null,
    loading: false,
    error: null,
    status: null,
    sampleCount: 0,
    paused: false,
    ...over,
  }) as MonitoringEntry;

const seedMonitors = (map: Record<string, MonitoringEntry>) => {
  monitorsView.monitors = map;
};

async function captureLogs(fn: () => Promise<void> | void): Promise<string[]> {
  const messages: string[] = [];
  const off = onFrontendLog((e) => messages.push(e.message));
  try {
    await fn();
  } finally {
    off();
  }
  return messages;
}

describe("monitoringSlice", () => {
  let store: ReturnType<typeof makeStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    seedMonitors({});
    store = makeStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts with no per-session capabilities", () => {
    expect(store.getState().sessionCapabilities).toEqual({});
  });

  it("setSessionCapabilities records caps per session", () => {
    store.getState().setSessionCapabilities("sess-a", { monitoring: true, fileBrowser: false });
    expect(store.getState().sessionCapabilities["sess-a"]).toEqual({
      monitoring: true,
      fileBrowser: false,
    });
  });

  describe("cancelMonitoring", () => {
    it("no-ops when the key has no entry", async () => {
      await store.getState().cancelMonitoring("missing");
      expect(mockedCancel).not.toHaveBeenCalled();
    });

    it("cancels the connect then drops a session-less entry via monitor.close", async () => {
      seedMonitors({ "sess-a": entry({ monitorSessionId: null }) });
      await store.getState().cancelMonitoring("sess-a");
      expect(mockedCancel).toHaveBeenCalledWith("sess-a");
      expect(mockedDispatch).toHaveBeenCalledWith("monitor.close", { key: "sess-a" });
    });

    it("swallows and logs a cancel rejection, then still tears the entry down", async () => {
      seedMonitors({ "sess-a": entry({ monitorSessionId: null }) });
      mockedCancel.mockRejectedValueOnce(new Error("abort failed"));
      const logs = await captureLogs(() => store.getState().cancelMonitoring("sess-a"));
      expect(logs.some((m) => m.includes("abort failed") && m.includes("sess-a"))).toBe(true);
      // Teardown still runs after the swallowed error.
      expect(mockedDispatch).toHaveBeenCalledWith("monitor.close", { key: "sess-a" });
    });
  });

  describe("disconnectMonitoring", () => {
    it("closes a live monitor via the backend command", async () => {
      seedMonitors({ "sess-a": entry({ monitorSessionId: "backend-1" }) });
      await store.getState().disconnectMonitoring("sess-a");
      expect(mockedClose).toHaveBeenCalledWith("backend-1");
    });

    it("swallows a close error (the entry is torn down regardless)", async () => {
      seedMonitors({ "sess-a": entry({ monitorSessionId: "backend-1" }) });
      mockedClose.mockRejectedValueOnce(new Error("close boom"));
      await expect(store.getState().disconnectMonitoring("sess-a")).resolves.toBeUndefined();
    });
  });

  describe("clearMonitoringError", () => {
    it("dispatches monitor.clearError only when the entry has an error", () => {
      seedMonitors({ "sess-a": entry({ error: "boom" }) });
      store.getState().clearMonitoringError("sess-a");
      expect(mockedDispatch).toHaveBeenCalledWith("monitor.clearError", { key: "sess-a" });
    });

    it("no-ops when the entry has no error", () => {
      seedMonitors({ "sess-a": entry({ error: null }) });
      store.getState().clearMonitoringError("sess-a");
      expect(mockedDispatch).not.toHaveBeenCalled();
    });
  });

  describe("setMonitoringPaused", () => {
    it("routes a live monitor through the backend command", async () => {
      seedMonitors({ "sess-a": entry({ monitorSessionId: "backend-1" }) });
      await store.getState().setMonitoringPaused("sess-a", true);
      expect(mockedSetPaused).toHaveBeenCalledWith("backend-1", true);
    });

    it("reflects a session-less pause into the region directly", async () => {
      seedMonitors({ "sess-a": entry({ monitorSessionId: null }) });
      await store.getState().setMonitoringPaused("sess-a", true);
      expect(mockedDispatch).toHaveBeenCalledWith("monitor.setPaused", {
        key: "sess-a",
        paused: true,
      });
    });
  });
});
