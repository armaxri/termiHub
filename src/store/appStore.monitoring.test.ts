import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock service modules before importing the store.
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

// The monitor lifecycle actions are now thin wrappers over the session monitoring
// commands: the backend owns the `system-monitors` region and folds every
// transition at the source (#2224/#2376). So these tests assert the action layer's
// contract — which command it invokes, and (for the transitions with no backend
// command) which client `monitor.*` intent it dispatches against the region —
// rather than any `appStore` state, which no longer exists.
const mockSessionMonitoringOpen = vi.fn();
const mockSessionMonitoringClose = vi.fn();
const mockSessionMonitoringSetPaused = vi.fn();
const mockSessionMonitoringSetInterval = vi.fn();
const mockSessionMonitoringCancel = vi.fn();

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  sessionMonitoringOpen: (...args: unknown[]) => mockSessionMonitoringOpen(...args),
  sessionMonitoringClose: (...args: unknown[]) => mockSessionMonitoringClose(...args),
  sessionMonitoringSetPaused: (...args: unknown[]) => mockSessionMonitoringSetPaused(...args),
  sessionMonitoringSetInterval: (...args: unknown[]) => mockSessionMonitoringSetInterval(...args),
  sessionMonitoringCancel: (...args: unknown[]) => mockSessionMonitoringCancel(...args),
}));

vi.mock("@/services/events", () => ({
  onPersistentSessionStateChanged: vi.fn(() => Promise.resolve(() => {})),
}));

import { useAppStore, monitorKeyForTab } from "./appStore";
import { currentMonitorsView, ensureMonitorsSubscribed } from "./systemMonitorBridge";
import {
  fakeMonitor,
  installMonitorHarness,
  monitorsView,
  type FakeMonitorTransport,
} from "@/test/systemMonitorHarness";
import { DEFAULT_MONITORING_INTERVAL_MS } from "@/types/monitoring";
import { flushMacrotask } from "@/test/flushAsync";
import type { SystemMonitorsView } from "./systemMonitorBridge";
import type { TerminalTab } from "@/types/terminal";

const SESSION_A = "term-sess-a";
const SESSION_B = "term-sess-b";
const HOST_A = "pi@pi.local:22";

let transport: FakeMonitorTransport;
let teardown: () => void;

/** Seed the region and make sure the bridge's cached view reflects it. */
async function seed(view: SystemMonitorsView) {
  await ensureMonitorsSubscribed();
  transport.seed(view);
  await flushMacrotask();
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.clearAllMocks();
  ({ transport, teardown } = installMonitorHarness());
});

afterEach(() => {
  teardown();
});

describe("connectMonitoring", () => {
  it("opens via session_monitoring_open with the host label and default interval", async () => {
    mockSessionMonitoringOpen.mockResolvedValue(undefined);

    await useAppStore.getState().connectMonitoring(SESSION_A, HOST_A);

    expect(mockSessionMonitoringOpen).toHaveBeenCalledWith(
      SESSION_A,
      HOST_A,
      DEFAULT_MONITORING_INTERVAL_MS
    );
  });

  it("preserves a previously-chosen interval sourced from the region", async () => {
    mockSessionMonitoringOpen.mockResolvedValue(undefined);
    await seed(monitorsView([fakeMonitor(SESSION_A, { intervalMs: 5000 })]));

    await useAppStore.getState().connectMonitoring(SESSION_A, HOST_A);

    expect(mockSessionMonitoringOpen).toHaveBeenCalledWith(SESSION_A, HOST_A, 5000);
  });

  it("propagates a failed connect (the backend already folded openFailed)", async () => {
    mockSessionMonitoringOpen.mockRejectedValue(new Error("Connection refused"));

    await expect(useAppStore.getState().connectMonitoring(SESSION_A, HOST_A)).rejects.toThrow(
      "Connection refused"
    );
  });
});

describe("disconnectMonitoring", () => {
  it("closes a live monitor through session_monitoring_close", async () => {
    mockSessionMonitoringClose.mockResolvedValue(undefined);
    await seed(monitorsView([fakeMonitor(SESSION_A, { monitorSessionId: SESSION_A })]));

    await useAppStore.getState().disconnectMonitoring(SESSION_A);

    expect(mockSessionMonitoringClose).toHaveBeenCalledWith(SESSION_A);
  });

  it("drops a no-session entry via a client monitor.close intent", async () => {
    await seed(monitorsView([fakeMonitor(SESSION_A, { monitorSessionId: null, error: "boom" })]));

    await useAppStore.getState().disconnectMonitoring(SESSION_A);
    await flushMacrotask();

    expect(mockSessionMonitoringClose).not.toHaveBeenCalled();
    expect(transport.kinds()).toContain("monitor.close");
    expect(currentMonitorsView().monitors[SESSION_A]).toBeUndefined();
  });

  it("with no key tears down every entry (commands for live, intents for the rest)", async () => {
    mockSessionMonitoringClose.mockResolvedValue(undefined);
    await seed(
      monitorsView([
        fakeMonitor(SESSION_A, { monitorSessionId: SESSION_A }),
        fakeMonitor(SESSION_B, { monitorSessionId: null }),
      ])
    );

    await useAppStore.getState().disconnectMonitoring();
    await flushMacrotask();

    expect(mockSessionMonitoringClose).toHaveBeenCalledWith(SESSION_A);
    expect(mockSessionMonitoringClose).toHaveBeenCalledTimes(1);
    expect(currentMonitorsView().monitors[SESSION_B]).toBeUndefined();
  });
});

describe("setMonitoringPaused", () => {
  it("routes a live monitor through session_monitoring_set_paused", async () => {
    mockSessionMonitoringSetPaused.mockResolvedValue(undefined);
    await seed(monitorsView([fakeMonitor(SESSION_A, { monitorSessionId: SESSION_A })]));

    await useAppStore.getState().setMonitoringPaused(SESSION_A, true);

    expect(mockSessionMonitoringSetPaused).toHaveBeenCalledWith(SESSION_A, true);
  });

  it("reflects a no-session pause into the region directly", async () => {
    await seed(monitorsView([fakeMonitor(SESSION_A, { monitorSessionId: null })]));

    await useAppStore.getState().setMonitoringPaused(SESSION_A, true);
    await flushMacrotask();

    expect(mockSessionMonitoringSetPaused).not.toHaveBeenCalled();
    expect(currentMonitorsView().monitors[SESSION_A].paused).toBe(true);
  });

  it("propagates a backend pause failure", async () => {
    mockSessionMonitoringSetPaused.mockRejectedValue(new Error("nope"));
    await seed(monitorsView([fakeMonitor(SESSION_A, { monitorSessionId: SESSION_A })]));

    await expect(useAppStore.getState().setMonitoringPaused(SESSION_A, true)).rejects.toThrow(
      "nope"
    );
  });
});

describe("setMonitoringInterval", () => {
  it("routes a live monitor through session_monitoring_set_interval", async () => {
    mockSessionMonitoringSetInterval.mockResolvedValue(undefined);
    await seed(monitorsView([fakeMonitor(SESSION_A, { monitorSessionId: SESSION_A })]));

    await useAppStore.getState().setMonitoringInterval(SESSION_A, 5000);

    expect(mockSessionMonitoringSetInterval).toHaveBeenCalledWith(SESSION_A, 5000);
  });

  it("persists a no-session interval into the region for the next connect", async () => {
    await seed(monitorsView([fakeMonitor(SESSION_A, { monitorSessionId: null })]));

    await useAppStore.getState().setMonitoringInterval(SESSION_A, 5000);
    await flushMacrotask();

    expect(mockSessionMonitoringSetInterval).not.toHaveBeenCalled();
    expect(currentMonitorsView().monitors[SESSION_A].intervalMs).toBe(5000);
  });
});

describe("clearMonitoringError", () => {
  it("clears a lingering error via a client monitor.clearError intent", async () => {
    await seed(monitorsView([fakeMonitor(SESSION_A, { monitorSessionId: null, error: "boom" })]));

    useAppStore.getState().clearMonitoringError(SESSION_A);
    await flushMacrotask();

    expect(transport.kinds()).toContain("monitor.clearError");
    expect(currentMonitorsView().monitors[SESSION_A].error).toBeNull();
  });

  it("is a no-op when the entry is absent or already clear", async () => {
    await seed(monitorsView([fakeMonitor(SESSION_A, { error: null })]));

    useAppStore.getState().clearMonitoringError(SESSION_A);
    useAppStore.getState().clearMonitoringError("unknown");
    await flushMacrotask();

    expect(transport.kinds()).not.toContain("monitor.clearError");
  });
});

describe("cancelMonitoring", () => {
  it("cancels the backend connect then tears the entry down", async () => {
    mockSessionMonitoringCancel.mockResolvedValue(undefined);
    await seed(
      monitorsView([
        fakeMonitor(SESSION_A, { monitorSessionId: null, loading: true, status: "connecting" }),
      ])
    );

    await useAppStore.getState().cancelMonitoring(SESSION_A);
    await flushMacrotask();

    expect(mockSessionMonitoringCancel).toHaveBeenCalledWith(SESSION_A);
    // The lingering no-session entry is dropped via monitor.close.
    expect(transport.kinds()).toContain("monitor.close");
    expect(currentMonitorsView().monitors[SESSION_A]).toBeUndefined();
  });
});

describe("monitorKeyForTab", () => {
  it("keys desktop-direct SSH tabs by their session id", () => {
    const tab = {
      connectionType: "ssh",
      sessionId: "term-sess-a",
      config: { type: "ssh", config: { host: "pi.local", port: 22, username: "pi" } },
    } as unknown as TerminalTab;
    expect(monitorKeyForTab(tab)).toBe("term-sess-a");
  });

  it("keys remote-session tabs by their session id", () => {
    const tab = {
      connectionType: "remote-session",
      sessionId: "sess-xyz",
      config: { type: "remote-session", config: {} },
    } as unknown as TerminalTab;
    expect(monitorKeyForTab(tab)).toBe("sess-xyz");
  });

  it("returns null when the tab has no session id", () => {
    const tab = {
      connectionType: "ssh",
      sessionId: null,
      config: { type: "ssh", config: { host: "pi.local", port: 22, username: "pi" } },
    } as unknown as TerminalTab;
    expect(monitorKeyForTab(tab)).toBeNull();
  });
});
