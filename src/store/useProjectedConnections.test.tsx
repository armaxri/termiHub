/**
 * `useProjectedConnections` — the connection tree sidebar reads the authoritative
 * `connections` region (#2225, PR A). Drives the hook against an in-memory
 * substrate double and asserts: it renders the server-fed region view directly,
 * re-renders on every region diff, and never reads the `appStore` slice (no seed,
 * no mirror gate, no fallback).
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

/** In-memory substrate double: feeds the region via {@link seed} and fans snapshots. */
class FakeTransport implements Transport {
  dispatched: Intent[] = [];
  private view: Record<string, unknown> = { folders: [], connections: [] };
  private version = 0;
  private handlers: FrameHandler[] = [];

  /** Feed the region as the server-side fold would, and fan the diff out. */
  seed(view: ConnectionsView): void {
    this.view = { folders: view.folders, connections: view.connections };
    this.version += 1;
    this.fan();
  }

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    return { intentId: intent.intentId, status: "accepted", produced: [] };
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
});

const flush = () => act(async () => await Promise.resolve());

describe("useProjectedConnections", () => {
  it("renders the server-fed region view directly", async () => {
    const folders = [folder("Work")];
    const connections = [connection("Work/A", "Work")];
    transport.seed({ folders, connections });

    const hook = renderHook();
    await flush();

    expect(hook.get().folders).toEqual(folders);
    expect(hook.get().connections).toEqual(connections);
    // The authoritative read dispatches nothing (no appStore seed).
    expect(transport.dispatched).toHaveLength(0);
    hook.unmount();
  });

  it("re-renders when the region diffs after mount", async () => {
    const hook = renderHook();
    await flush();
    expect(hook.get().connections).toHaveLength(0);

    act(() => transport.seed({ folders: [folder("A")], connections: [connection("A/1", "A")] }));
    await flush();

    expect(hook.get().folders[0].id).toBe("A");
    expect(hook.get().connections[0].id).toBe("A/1");
    hook.unmount();
  });

  it("ignores the appStore slice entirely (region is the source of truth)", async () => {
    // appStore holds a divergent slice; the hook must not read it.
    useAppStore.setState({
      folders: [folder("Stale")],
      connections: [connection("stale-1")],
    });
    const regionFolders = [folder("Live")];
    const regionConnections = [connection("live-1", "Live")];
    transport.seed({ folders: regionFolders, connections: regionConnections });

    const hook = renderHook();
    await flush();

    expect(hook.get().folders).toEqual(regionFolders);
    expect(hook.get().connections).toEqual(regionConnections);
    hook.unmount();
  });
});
