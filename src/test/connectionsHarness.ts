/**
 * Test harness for the region-authoritative connections domain (#2225, PR B).
 *
 * After the reducer removal (#2401), `appStore` no longer holds the
 * `connections` / `folders` slice: the saved-connection / folder inventory lives
 * only in the shared `connections` projection region, which every reader (the
 * sidebar, the connection editor, the command palette, the tunnel/workflow
 * sidebars, …) and the store's own connect / session / tab logic source through
 * {@link import("@/store/connectionsBridge").currentConnectionsView} /
 * {@link import("@/store/useProjectedConnections").useProjectedConnections}.
 *
 * In production that region is fed server-side (#2389 / #2394). In a unit /
 * component test there is no backend, so this harness seeds the region **directly**
 * — the replacement for the old `useAppStore.setState({ connections, folders })`
 * idiom. It installs a transport double whose subscription snapshot always
 * reflects the seeded view (so a hook mounting after the seed agrees with the
 * synchronously-primed region cache) and exposes {@link seedConnectionsRegion} to
 * set / extend that view.
 *
 * This supersedes the render-cut-era `connectionsRegionTestHarness`, which
 * mirrored `appStore` into the region — a bridge that no longer exists now that
 * `appStore` holds no connections slice.
 *
 * Usage: call {@link setupConnectionsRegion} once at the top of a test module (it
 * registers its own `beforeEach` / `afterEach`), then `seedConnectionsRegion({ … })`
 * inside a test to populate the region.
 */

import { afterEach, beforeEach } from "vitest";

import type {
  FrameHandler,
  Intent,
  IntentAck,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";
import {
  setConnectionsViewForTest,
  setConnectionTransportForTest,
  stopConnectionsSubscription,
  type ConnectionsView,
} from "@/store/connectionsBridge";
import type { ConnectionFolder, SavedConnection } from "@/types/connection";

/** The empty region view a fresh test starts from. */
const EMPTY: ConnectionsView = { folders: [], connections: [] };

/** The currently-seeded region view, mirrored by {@link SeededTransport}'s snapshot. */
let current: ConnectionsView = EMPTY;

/**
 * Apply a `connection.*` intent to the seeded view, mirroring the Rust
 * [`ConnectionsStore`](../../src-tauri/src/connections_projection/store.rs)
 * routes one-to-one — the faithful stand-in for the server-side fold. This is
 * what lets a component test drive a real UI mutation (click delete, drag into a
 * folder, toggle a chevron) and see the region — and therefore the rendered tree
 * — update, exactly as the backend fold would in production.
 */
function applyIntent(
  view: ConnectionsView,
  kind: string,
  payload: Record<string, unknown>
): ConnectionsView {
  const folders = [...view.folders];
  let connections = [...view.connections];
  switch (kind) {
    case "connection.add":
      connections.push(payload.connection as SavedConnection);
      break;
    case "connection.update": {
      const next = payload.connection as SavedConnection;
      connections = connections.map((c) => (c.id === next.id ? next : c));
      break;
    }
    case "connection.remove":
      connections = connections.filter((c) => c.id !== (payload.connectionId as string));
      break;
    case "connection.move": {
      const id = payload.connectionId as string;
      const folderId = (payload.folderId as string | null | undefined) ?? null;
      connections = connections.map((c) => (c.id === id ? { ...c, folderId } : c));
      break;
    }
    case "connection.addFolder":
      folders.push(payload.folder as ConnectionFolder);
      break;
    case "connection.removeFolder": {
      const folderId = payload.folderId as string;
      const removed = folders.find((f) => f.id === folderId);
      const parentId = removed?.parentId ?? null;
      connections = connections.map((c) =>
        c.folderId === folderId ? { ...c, folderId: null } : c
      );
      const kept = folders
        .filter((f) => f.id !== folderId)
        .map((f) => (f.parentId === folderId ? { ...f, parentId } : f));
      return { folders: kept, connections };
    }
    case "connection.toggleFolder": {
      const folderId = payload.folderId as string;
      return {
        folders: folders.map((f) => (f.id === folderId ? { ...f, isExpanded: !f.isExpanded } : f)),
        connections,
      };
    }
    default:
      break;
  }
  return { folders, connections };
}

/**
 * A transport double whose region subscription snapshot always reflects the
 * currently-seeded view — so the reader hooks' mount-time subscribe agrees with
 * the synchronously-primed region cache (no clobber back to empty). Dispatched
 * `connection.*` intents are recorded (for {@link connectionsHarnessDispatched})
 * **and** folded into the seeded view via {@link applyIntent}, standing in for the
 * production server-side fold so a UI-driven mutation updates the rendered tree.
 */
class SeededTransport implements Transport {
  dispatched: Intent[] = [];

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    if (typeof intent.kind === "string" && intent.kind.startsWith("connection.")) {
      current = applyIntent(
        current,
        intent.kind,
        (intent.payload ?? {}) as Record<string, unknown>
      );
      setConnectionsViewForTest(current);
    }
    return { intentId: intent.intentId, status: "accepted", produced: [] };
  }

  async subscribe(region: string, _onFrame: FrameHandler): Promise<Subscription> {
    return {
      snapshot: { kind: "snapshot", region, version: 1, view: structuredClone(current) },
      unsubscribe: () => {},
    };
  }

  async resync(): Promise<SnapshotFrame | null> {
    return null;
  }
}

let activeTransport: SeededTransport | null = null;

/**
 * Seed (or extend) the authoritative `connections` region for the current test.
 * Merges with the currently-seeded view — passing only `folders` leaves the
 * seeded `connections` untouched and vice-versa — mirroring how the retired
 * `useAppStore.setState({ folders })` shallow-merged the slice. Fans the new view
 * to any subscribed reader hooks so they re-render.
 */
export function seedConnectionsRegion(partial: {
  folders?: ConnectionFolder[];
  connections?: SavedConnection[];
}): void {
  current = {
    folders: partial.folders ?? current.folders,
    connections: partial.connections ?? current.connections,
  };
  setConnectionsViewForTest(current);
}

/** Reset the seeded region back to empty (called by the `beforeEach` install). */
export function resetConnectionsRegion(): void {
  current = EMPTY;
  setConnectionsViewForTest(current);
}

/** The intents the transport double has recorded this test (mutation-cut assertions). */
export function connectionsHarnessDispatched(): Intent[] {
  return activeTransport?.dispatched ?? [];
}

/**
 * Install the region transport double and reset the seed to empty. Returns a
 * teardown. Prefer {@link setupConnectionsRegion}, which wires the lifecycle.
 */
export function installConnectionsRegion(): () => void {
  activeTransport = new SeededTransport();
  setConnectionTransportForTest(activeTransport);
  resetConnectionsRegion();
  return () => {
    stopConnectionsSubscription();
    setConnectionTransportForTest(null);
    activeTransport = null;
    current = EMPTY;
  };
}

/**
 * Register a `beforeEach` / `afterEach` pair that installs the region transport
 * double (seeded empty) for every test in the current module. Call once at module
 * scope, then use {@link seedConnectionsRegion} inside individual tests.
 */
export function setupConnectionsRegion(): void {
  let teardown: (() => void) | undefined;
  beforeEach(() => {
    teardown = installConnectionsRegion();
  });
  afterEach(() => {
    teardown?.();
    teardown = undefined;
  });
}
