/**
 * `useProjectedConnections` — the connection tree sidebar cut to the projected
 * `connections` region (#2225 render cut). Drives the hook against an in-memory
 * substrate double and asserts: flag-off returns the appStore slice and dispatches
 * nothing; flag-on seeds the region (a `connection.replace` mirror) and then
 * renders the slice from the projection, value-identical to appStore; and a region
 * that has not caught up falls back to the appStore slice.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  FrameHandler,
  Intent,
  IntentAck,
  ProjectionFrame,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";
import { useAppStore } from "@/store/appStore";
import type { ConnectionFolder, SavedConnection } from "@/types/connection";

import {
  CONNECTIONS_REGION,
  setConnectionRenderFromProjectionEnabled,
  setConnectionTransportForTest,
  stopConnectionsSubscription,
  type ConnectionsView,
} from "./connectionsBridge";
import { useProjectedConnections } from "./useProjectedConnections";

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  getSettings: vi.fn(() =>
    Promise.resolve({ version: "1", externalConnectionFiles: [], powerMonitoringEnabled: true })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn(() => vi.fn()) }));

function connection(id: string, folderId: string | null = null): SavedConnection {
  return {
    id,
    name: `Conn ${id}`,
    config: { type: "ssh", host: `h-${id}`, port: 22 } as never,
    folderId,
  };
}

function folder(id: string, parentId: string | null = null, isExpanded = true): ConnectionFolder {
  return { id, name: `F ${id}`, parentId, isExpanded };
}

/** In-memory substrate double: applies `connection.replace` and fans a snapshot. */
class FakeTransport implements Transport {
  dispatched: Intent[] = [];
  /** When false, `connection.replace` acks but does NOT advance the region. */
  applyReplace = true;
  private view: Record<string, unknown> = { folders: [], connections: [] };
  private version = 0;
  private handlers: FrameHandler[] = [];

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    if (intent.kind === "connection.replace" && this.applyReplace) {
      const p = intent.payload as Record<string, unknown>;
      this.view = { folders: p.folders ?? [], connections: p.connections ?? [] };
      this.version += 1;
      this.fan();
    }
    return {
      intentId: intent.intentId,
      status: "accepted",
      produced: [{ region: CONNECTIONS_REGION, version: this.version }],
    };
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

  private snapshot(region: string): SnapshotFrame {
    return { kind: "snapshot", region, version: this.version, view: structuredClone(this.view) };
  }

  private fan(): void {
    const frame: ProjectionFrame = this.snapshot(CONNECTIONS_REGION);
    for (const h of this.handlers) h(frame);
  }
}

/** Render the hook into a throwaway component, exposing the latest return value. */
function renderHook(): { get: () => ConnectionsView; unmount: () => void } {
  const container = document.createElement("div");
  const root: Root = createRoot(container);
  let latest: ConnectionsView = { folders: [], connections: [] };

  function Probe() {
    latest = useProjectedConnections();
    return null;
  }

  act(() => root.render(<Probe />));
  return { get: () => latest, unmount: () => act(() => root.unmount()) };
}

let transport: FakeTransport;

beforeEach(() => {
  transport = new FakeTransport();
  setConnectionTransportForTest(transport);
  useAppStore.setState({ folders: [], connections: [] });
});

afterEach(() => {
  stopConnectionsSubscription();
  setConnectionTransportForTest(null);
  setConnectionRenderFromProjectionEnabled(null);
});

const flush = () => act(async () => await Promise.resolve());

describe("useProjectedConnections", () => {
  it("flag off: returns the appStore slice and dispatches nothing", async () => {
    setConnectionRenderFromProjectionEnabled(false);
    useAppStore.setState({
      folders: [folder("Work")],
      connections: [connection("Work/A", "Work")],
    });

    const hook = renderHook();
    await flush();

    expect(hook.get().folders[0].id).toBe("Work");
    expect(hook.get().connections).toHaveLength(1);
    expect(transport.dispatched).toHaveLength(0);
    hook.unmount();
  });

  it("flag on: seeds the region then renders the slice from the projection", async () => {
    const folders = [folder("Work")];
    const connections = [connection("Work/A", "Work")];
    useAppStore.setState({ folders, connections });

    const hook = renderHook();
    await flush();
    await flush();

    // The hook seeded appStore's slice via connection.replace…
    expect(transport.dispatched.some((d) => d.kind === "connection.replace")).toBe(true);
    // …and now renders a value-identical slice (sourced from the projection).
    expect(hook.get().folders).toEqual(folders);
    expect(hook.get().connections).toEqual(connections);
    hook.unmount();
  });

  it("region not caught up: falls back to the appStore slice", async () => {
    transport.applyReplace = false; // the replace acks but never advances the region
    const folders = [folder("Solo", null, false)];
    const connections = [connection("root-a")];
    useAppStore.setState({ folders, connections });

    const hook = renderHook();
    await flush();
    await flush();

    // The projection stays empty, so the gate rejects it and the hook renders the
    // appStore slice verbatim — parity preserved.
    expect(hook.get().folders).toEqual(folders);
    expect(hook.get().connections).toEqual(connections);
    hook.unmount();
  });
});
