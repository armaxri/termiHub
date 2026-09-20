import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Branch-coverage suite (#3027, TFE-005 follow-up) for terminal session-lifecycle
 * guard / error / flag-clear branches in `appStore.ts` left dark by the existing
 * suites:
 *
 *  - `consumeSessionKilled`: the "was an intentional kill → consume + clear" arm
 *    and the "unknown session → false" arm (the intentional-kill flag must be a
 *    one-shot; a second consume returns false).
 *  - `settleSessionLost` / `settleBackendReconnectGaveUp`: both clear every
 *    in-flight per-client connect flag (deadline / waiting / auto-retry /
 *    spawn-error) for the settling tab while leaving other tabs' flags intact —
 *    so no competing connect overlay lingers over the region-owned terminal state.
 *  - `reconnectFailedRestoreTabs`: the empty-capture early return and the
 *    captured-but-no-live-terminal-tab early return (a stale failed-set entry
 *    whose tab has since closed must not trigger a bulk-retry toast / re-drive).
 *  - `setTerminalDisconnectWithError`: the reconnecting-skip guard — while the
 *    region shows the tab reconnecting, the backend redrive owns the outcome, so
 *    the client must NOT emit a divergent `session.connectFailed`.
 *
 * The session-lifecycle region is driven through an in-memory transport double
 * (folds `session.reconnect` → reconnecting, as the backend routes it) so
 * `currentSessionView()` reflects the reconnecting state the guard reads.
 */

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/components/ui", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(() => "toast-id"),
    promise: vi.fn(),
    dismiss: vi.fn(),
  },
}));

import type {
  FrameHandler,
  Intent,
  IntentAck,
  ProjectionFrame,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";

import { useAppStore } from "./appStore";
import {
  currentSessionView,
  SESSION_LIFECYCLE_REGION,
  setSessionTransportForTest,
  stopSessionSubscription,
  type ProjectedSessionLifecycle,
} from "./sessionBridge";
import { setupRestoreCohortRegion } from "@/test/restoreCohortHarness";
import { toast } from "@/components/ui";

const mockToast = vi.mocked(toast);

/**
 * A `session-lifecycle` substrate double: records every dispatched intent and
 * folds the reconnect-relevant `session.reconnect` (→ reconnecting/waiting) so the
 * region reflects it, mirroring the backend's route (see appStore.autoReconnect).
 */
class FakeSessionTransport implements Transport {
  dispatched: Intent[] = [];
  private sessions: Record<string, ProjectedSessionLifecycle> = {};
  private version = 0;
  private handlers: FrameHandler[] = [];

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    const id = (intent.payload as { sessionId: string }).sessionId;
    if (intent.kind === "session.reconnect") {
      this.sessions[id] = {
        status: "reconnecting",
        reconnect: { phase: "waiting", attempt: 0, delayMs: 1000 },
      };
      this.version += 1;
      this.fan();
    }
    const produced =
      intent.kind === "session.reconnect"
        ? [{ region: SESSION_LIFECYCLE_REGION, version: this.version }]
        : [];
    return { intentId: intent.intentId, status: "accepted", produced };
  }

  async subscribe(region: string, onFrame: FrameHandler): Promise<Subscription> {
    this.handlers.push(onFrame);
    return {
      snapshot: this.snapshot(region),
      unsubscribe: () => {
        this.handlers = this.handlers.filter((h) => h !== onFrame);
      },
    };
  }

  async resync(): Promise<SnapshotFrame | null> {
    return null;
  }

  kinds(): string[] {
    return this.dispatched.map((i) => i.kind);
  }

  kindsFor(sessionId: string): string[] {
    return this.dispatched
      .filter((i) => (i.payload as { sessionId?: string }).sessionId === sessionId)
      .map((i) => i.kind);
  }

  private snapshot(region: string): SnapshotFrame {
    return {
      kind: "snapshot",
      region,
      version: this.version,
      view: structuredClone({ sessions: this.sessions }),
    };
  }

  private fan(): void {
    const frame: ProjectionFrame = this.snapshot(SESSION_LIFECYCLE_REGION);
    for (const h of this.handlers) h(frame);
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Create a plain-SSH terminal tab; `resilient` toggles the reconnect opt-in. */
function makeSshTab(resilient: boolean, sessionId: string | null = "sess-1"): string {
  return useAppStore.getState().addTab(
    "web01",
    "ssh",
    {
      type: "ssh",
      config: {
        host: "web01.example.com",
        username: "deploy",
        resilientReconnect: resilient,
      },
    },
    { contentType: "terminal", sessionId }
  );
}

setupRestoreCohortRegion();

let fake: FakeSessionTransport;

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.clearAllMocks();
  fake = new FakeSessionTransport();
  setSessionTransportForTest(fake);
});

afterEach(() => {
  stopSessionSubscription();
  setSessionTransportForTest(null);
});

describe("appStore — consumeSessionKilled", () => {
  it("returns true and clears the flag when the session was intentionally killed", () => {
    useAppStore.getState().markSessionKilled("sess-1");

    expect(useAppStore.getState().consumeSessionKilled("sess-1")).toBe(true);
    // One-shot: the flag is cleared, so a second consume returns false.
    expect(useAppStore.getState().intentionallyKilledSessions["sess-1"]).toBeUndefined();
    expect(useAppStore.getState().consumeSessionKilled("sess-1")).toBe(false);
  });

  it("returns false without mutating state for an unknown session", () => {
    const before = { ...useAppStore.getState().intentionallyKilledSessions };

    expect(useAppStore.getState().consumeSessionKilled("never-killed")).toBe(false);

    expect(useAppStore.getState().intentionallyKilledSessions).toEqual(before);
  });
});

describe("appStore — settleSessionLost clears in-flight connect flags", () => {
  it("clears the settling tab's flags while leaving other tabs untouched", () => {
    useAppStore.getState().setTerminalWaitingForAgent("tab-a", "agent-x"); // arms deadline + waiting
    useAppStore.getState().setTerminalAutoRetrying("tab-a", 3);
    useAppStore.setState((s) => ({
      terminalSpawnErrors: { ...s.terminalSpawnErrors, "tab-a": "prev error" },
    }));
    // A second, unrelated tab whose flags must survive.
    useAppStore.getState().setTerminalWaitingForAgent("tab-b", "agent-y");

    useAppStore.getState().settleSessionLost("tab-a");

    const s = useAppStore.getState();
    expect(s.terminalConnectDeadline["tab-a"]).toBeUndefined();
    expect(s.terminalWaitingForAgent["tab-a"]).toBeUndefined();
    expect(s.terminalAutoRetryCount["tab-a"]).toBeUndefined();
    expect(s.terminalSpawnErrors["tab-a"]).toBeUndefined();
    // The unrelated tab is left intact.
    expect(s.terminalWaitingForAgent["tab-b"]).toBe("agent-y");
  });
});

describe("appStore — settleBackendReconnectGaveUp clears in-flight connect flags", () => {
  it("clears the settling tab's flags while leaving other tabs untouched", () => {
    useAppStore.getState().setTerminalWaitingForAgent("tab-a", "agent-x");
    useAppStore.getState().setTerminalAutoRetrying("tab-a", 2);
    useAppStore.setState((s) => ({
      terminalSpawnErrors: { ...s.terminalSpawnErrors, "tab-a": "boom" },
    }));
    useAppStore.getState().setTerminalAutoRetrying("tab-b", 5);

    useAppStore.getState().settleBackendReconnectGaveUp("tab-a", "gave up");

    const s = useAppStore.getState();
    expect(s.terminalConnectDeadline["tab-a"]).toBeUndefined();
    expect(s.terminalWaitingForAgent["tab-a"]).toBeUndefined();
    expect(s.terminalAutoRetryCount["tab-a"]).toBeUndefined();
    expect(s.terminalSpawnErrors["tab-a"]).toBeUndefined();
    expect(s.terminalAutoRetryCount["tab-b"]).toBe(5);
  });
});

describe("appStore — reconnectFailedRestoreTabs early returns", () => {
  it("is a no-op (no bulk-retry toast) when nothing was captured as failed", () => {
    useAppStore.getState().reconnectFailedRestoreTabs();

    expect(mockToast.loading).not.toHaveBeenCalled();
  });

  it("is a no-op when the captured failed tab no longer exists as a live terminal", async () => {
    // Capture a failed tab in the region, then never create a matching live tab.
    useAppStore.getState().beginRestoreCohort(["gone-tab"], 0, "cohort-toast");
    useAppStore.getState().settleRestoreTab("gone-tab", "failed");
    await flush();

    useAppStore.getState().reconnectFailedRestoreTabs();

    // The captured id filters out (no live terminal), so no bulk retry is kicked off.
    expect(mockToast.loading).not.toHaveBeenCalled();
  });
});

describe("appStore — setTerminalDisconnectWithError reconnecting-skip guard", () => {
  it("emits session.connectFailed when the tab is NOT reconnecting", () => {
    const tabId = makeSshTab(false);

    useAppStore.getState().setTerminalDisconnectWithError(tabId, "connect refused");

    expect(fake.kindsFor(tabId)).toContain("session.connectFailed");
  });

  it("does NOT emit session.connectFailed while the region shows the tab reconnecting", async () => {
    const tabId = makeSshTab(true);

    // Drive the tab into the region's reconnecting state via an unexpected drop.
    useAppStore.getState().setTerminalExited(tabId, { code: null, reason: "dropped" });
    await flush();
    expect(currentSessionView()[tabId]?.status).toBe("reconnecting");

    useAppStore.getState().setTerminalDisconnectWithError(tabId, "connect refused");

    // The backend redrive owns the reconnect outcome, so the client stays silent.
    expect(fake.kindsFor(tabId)).not.toContain("session.connectFailed");
  });
});
