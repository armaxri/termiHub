/**
 * The projection hooks' subscribe fallbacks and unmount guards (#3992).
 *
 * Every `useProjected*` hook (and the session-lifecycle readers) follows the same
 * shape: seed from the bridge's cached view, register a view listener, then call
 * the bridge's `ensure*Subscribed()` and re-read once it resolves. Three paths in
 * that shape had no test:
 *
 * - **No transport.** Outside Tauri with no socket, building the transport throws
 *   *synchronously*. The hook must swallow it, log it, and render the baseline.
 * - **Subscribe rejects.** The bridge logs and rethrows; the hook must catch the
 *   rejection (no unhandled rejection), log it, and keep the baseline.
 * - **Unmount before the subscription resolves.** The late resolution must not
 *   push state into the unmounted component, and the listener it registered must
 *   be gone, so a later diff reaches only live consumers.
 *
 * The cases are table-driven over the real bridges with a scripted transport, so
 * each hook runs the exact production subscribe path.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  FrameHandler,
  Intent,
  IntentAck,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";
import type { LogEntry } from "@/types/terminal";
import { onFrontendLog } from "@/utils/frontendLog";

import {
  currentAgentsView,
  setAgentTransportForTest,
  stopAgentsSubscription,
} from "./agentsBridge";
import {
  currentBroadcastView,
  setBroadcastTransportForTest,
  stopBroadcastSubscription,
} from "./broadcastBridge";
import {
  currentConnectionsView,
  setConnectionTransportForTest,
  stopConnectionsSubscription,
} from "./connectionsBridge";
import {
  currentFileBrowsersView,
  setFileBrowsersTransportForTest,
  stopFileBrowsersSubscription,
} from "./fileBrowsersBridge";
import { setSessionTransportForTest, stopSessionSubscription } from "./sessionBridge";
import {
  currentSettingsView,
  setSettingsTransportForTest,
  stopSettingsSubscription,
} from "./settingsBridge";
import {
  currentMonitorsView,
  setMonitorTransportForTest,
  stopMonitorsSubscription,
} from "./systemMonitorBridge";
import {
  currentTransfersView,
  setTransferTransportForTest,
  stopTransfersSubscription,
} from "./transfersBridge";
import {
  currentWorkflowRunView,
  setWorkflowTransportForTest,
  stopWorkflowSubscription,
} from "./workflowRunBridge";
import { useProjectedAgents } from "./useProjectedAgents";
import { useProjectedBroadcast } from "./useProjectedBroadcast";
import { useProjectedConnections } from "./useProjectedConnections";
import { useProjectedFileBrowsers } from "./useProjectedFileBrowsers";
import { useProjectedMonitors } from "./useProjectedMonitors";
import { useProjectedSettings } from "./useProjectedSettings";
import { useProjectedTransfers } from "./useProjectedTransfers";
import { useProjectedWorkflowRun } from "./useProjectedWorkflowRun";
import {
  useProjectedSessionLifecycle,
  useProjectedSessionLifecycleMaps,
  useSessionAutoReconnect,
} from "./useSessionLifecycle";

/**
 * A transport whose `subscribe` either rejects or stays pending until the test
 * releases it with a chosen snapshot view.
 */
class ScriptedTransport implements Transport {
  subscribeCalls = 0;
  unsubscribed = 0;
  private handlers: Array<{ region: string; onFrame: FrameHandler }> = [];
  private pending: Array<{ region: string; resolve: (s: Subscription) => void }> = [];

  constructor(private readonly mode: "reject" | "deferred") {}

  async dispatch(intent: Intent): Promise<IntentAck> {
    return { intentId: intent.intentId, status: "accepted", produced: [] };
  }

  subscribe(region: string, onFrame: FrameHandler): Promise<Subscription> {
    this.subscribeCalls += 1;
    if (this.mode === "reject") return Promise.reject(new Error("socket closed"));
    this.handlers.push({ region, onFrame });
    return new Promise((resolve) => this.pending.push({ region, resolve }));
  }

  async resync(): Promise<SnapshotFrame | null> {
    return null;
  }

  /** Resolve every pending subscribe with a snapshot carrying `view`. */
  release(view: unknown, version = 1): void {
    for (const { region, resolve } of this.pending.splice(0)) {
      resolve({
        snapshot: { kind: "snapshot", region, version, view },
        unsubscribe: () => {
          this.unsubscribed += 1;
        },
      });
    }
  }

  /** Push a later snapshot frame to every subscriber (a region diff). */
  push(view: unknown, version: number): void {
    for (const { region, onFrame } of this.handlers) {
      onFrame({ kind: "snapshot", region, version, view });
    }
  }
}

interface HookCase {
  name: string;
  /** Render the hook, returning whatever it returns. */
  use: () => unknown;
  setTransport: (t: Transport | null) => void;
  stop: () => void;
  /** The frontendLog target the owning bridge writes to. */
  target: string;
  /** What the hook renders before any region data arrives. */
  baseline: () => unknown;
}

const TAB = "tab-1";

const CASES: HookCase[] = [
  {
    name: "useProjectedAgents",
    use: useProjectedAgents,
    setTransport: setAgentTransportForTest,
    stop: stopAgentsSubscription,
    target: "agent_bridge",
    baseline: currentAgentsView,
  },
  {
    name: "useProjectedBroadcast",
    use: () => {
      const s = useProjectedBroadcast();
      return { ...s, targetTabIds: [...s.targetTabIds] };
    },
    setTransport: setBroadcastTransportForTest,
    stop: stopBroadcastSubscription,
    target: "broadcast_bridge",
    baseline: currentBroadcastView,
  },
  {
    name: "useProjectedConnections",
    use: useProjectedConnections,
    setTransport: setConnectionTransportForTest,
    stop: stopConnectionsSubscription,
    target: "connection_bridge",
    baseline: currentConnectionsView,
  },
  {
    name: "useProjectedFileBrowsers",
    use: useProjectedFileBrowsers,
    setTransport: setFileBrowsersTransportForTest,
    stop: stopFileBrowsersSubscription,
    target: "file_browsers_bridge",
    baseline: currentFileBrowsersView,
  },
  {
    name: "useProjectedMonitors",
    use: useProjectedMonitors,
    setTransport: setMonitorTransportForTest,
    stop: stopMonitorsSubscription,
    target: "monitor_bridge",
    baseline: currentMonitorsView,
  },
  {
    name: "useProjectedSettings",
    use: useProjectedSettings,
    setTransport: setSettingsTransportForTest,
    stop: stopSettingsSubscription,
    target: "settings_bridge",
    baseline: currentSettingsView,
  },
  {
    name: "useProjectedTransfers",
    use: useProjectedTransfers,
    setTransport: setTransferTransportForTest,
    stop: stopTransfersSubscription,
    target: "transfer_bridge",
    baseline: currentTransfersView,
  },
  {
    name: "useProjectedWorkflowRun",
    use: useProjectedWorkflowRun,
    setTransport: setWorkflowTransportForTest,
    stop: stopWorkflowSubscription,
    target: "workflow_run_bridge",
    baseline: () => {
      const v = currentWorkflowRunView();
      return { workflowRun: v.run, workflowRuns: v.runs, workflowRunOutput: null };
    },
  },
  {
    name: "useProjectedSessionLifecycleMaps",
    use: useProjectedSessionLifecycleMaps,
    setTransport: setSessionTransportForTest,
    stop: stopSessionSubscription,
    target: "session_bridge",
    baseline: () => ({
      terminalConnecting: {},
      terminalReconnectingTabs: {},
      terminalDisconnectErrors: {},
      terminalSessionLost: {},
      terminalEvicted: {},
      terminalExitedTabs: {},
    }),
  },
  {
    name: "useProjectedSessionLifecycle",
    use: () => useProjectedSessionLifecycle(TAB),
    setTransport: setSessionTransportForTest,
    stop: stopSessionSubscription,
    target: "session_bridge",
    baseline: () => null,
  },
  {
    name: "useSessionAutoReconnect",
    use: () => useSessionAutoReconnect(TAB) ?? null,
    setTransport: setSessionTransportForTest,
    stop: stopSessionSubscription,
    target: "session_bridge",
    baseline: () => null,
  },
];

let root: Root | null = null;
let logs: LogEntry[] = [];
let offLog: (() => void) | null = null;

/** Render `use` in a probe; returns the latest value and the render count. */
function mount(use: () => unknown): { latest: () => unknown; renders: () => number } {
  let latest: unknown;
  let renders = 0;
  function Probe(): ReactElement | null {
    latest = use();
    renders += 1;
    return null;
  }
  root = createRoot(document.createElement("div"));
  act(() => root!.render(<Probe />));
  return { latest: () => latest, renders: () => renders };
}

function unmount(): void {
  if (root) act(() => root!.unmount());
  root = null;
}

const flush = () => act(async () => await new Promise((r) => setTimeout(r, 0)));

beforeEach(() => {
  logs = [];
  offLog = onFrontendLog((entry) => logs.push(entry));
});

afterEach(() => {
  unmount();
  offLog?.();
});

describe.each(CASES)("$name subscribe fallbacks", (c) => {
  afterEach(() => {
    c.stop();
    c.setTransport(null);
  });

  const subscribeLogs = () =>
    logs.filter((l) => l.target.endsWith(c.target) && l.message.startsWith("subscribe"));

  it("renders the baseline and logs when no transport can be built (non-Tauri, no socket)", async () => {
    // `null` drops the injected double; the lazy real transport then throws
    // synchronously because jsdom is neither Tauri nor carries a socket.
    c.setTransport(null);
    const expected = c.baseline();
    const hook = mount(c.use);
    await flush();

    if (expected !== null) expect(hook.latest()).toEqual(expected);
    expect(subscribeLogs().length).toBeGreaterThan(0);
    expect(subscribeLogs()[0].message).toMatch(/JSON-RPC socket/);
  });

  it("keeps the baseline and logs when the subscribe rejects", async () => {
    const transport = new ScriptedTransport("reject");
    c.setTransport(transport);
    const expected = c.baseline();
    const hook = mount(c.use);
    await flush();

    expect(transport.subscribeCalls).toBe(1);
    if (expected !== null) expect(hook.latest()).toEqual(expected);
    // The bridge logs the failure and the hook logs the rethrown rejection.
    expect(subscribeLogs().length).toBeGreaterThanOrEqual(2);
    expect(subscribeLogs().every((l) => /socket closed/.test(l.message))).toBe(true);
  });

  it("ignores a subscription that resolves after unmount and drops its listener", async () => {
    const transport = new ScriptedTransport("deferred");
    c.setTransport(transport);
    const hook = mount(c.use);
    await flush();
    const rendersAtUnmount = hook.renders();

    unmount();
    // The subscription lands (and a later diff arrives) only after unmount.
    await act(async () => {
      transport.release(undefined);
      await new Promise((r) => setTimeout(r, 0));
      transport.push(undefined, 2);
    });

    expect(hook.renders()).toBe(rendersAtUnmount);
    expect(subscribeLogs()).toEqual([]);
  });
});
