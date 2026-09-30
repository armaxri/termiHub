/**
 * A faithful in-memory double of the connections backend (#2831): the
 * persisted connection tree ("disk"), the persist commands that write it, and
 * the shared `connections` projection region those commands fold it into.
 *
 * It models the production contract the connections bridge relies on:
 *
 * - **The persist command is the single region writer.** Every command runs
 *   through {@link ConnectionsBackendDouble.commit} — the twin of the Rust
 *   `commit` choke point — which writes "disk" and then folds disk into the
 *   region, **whatever the outcome**: a failed command re-folds too, so a write
 *   that partly reached disk is published exactly and a clean failure publishes
 *   nothing (the region already equals disk).
 * - **The fold's frame is independent of the command reply.** A diff frame is
 *   delivered on a later macrotask, so a command's promise can settle while its
 *   frame is still in flight — the race the bridge's catch-up barrier covers.
 *   {@link resync} answers with the current snapshot, like `projection_resync`.
 * - **No `connection.*` intents exist.** {@link dispatched} records any intent
 *   so a test can assert the domain never dispatches one.
 *
 * Wire it by pointing the `@/services/storage` mocks at an instance's commands
 * and installing it with `setConnectionTransportForTest`.
 */

import { compare } from "fast-json-patch";

import type {
  DiffOp,
  FrameHandler,
  Intent,
  IntentAck,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";
import type { ConnectionsView } from "@/store/connectionsOverlay";
import type { ConnectionFolder, SavedConnection } from "@/types/connection";

/** The persist commands the double serves (the `@/services/storage` names). */
export type ConnectionsCommand =
  | "persistConnection"
  | "removeConnection"
  | "persistFolder"
  | "removeFolder"
  | "reorderConnections"
  | "moveConnectionToFile"
  | "saveConnectionToFile";

/** How a scheduled failure behaves. */
export interface FailureOptions {
  /** Only fail the call for this connection / folder id (per-item batches). */
  id?: string;
  /** Part of the write that reaches disk before the failure. */
  partial?: (disk: ConnectionsView) => ConnectionsView;
}

/** A scheduled failure: the error plus its {@link FailureOptions}. */
interface Failure extends FailureOptions {
  error: unknown;
}

export class ConnectionsBackendDouble implements Transport {
  /** Intents seen — the connections domain must never dispatch one. */
  readonly dispatched: Intent[] = [];
  /** Every command called, in call order. */
  readonly calls: ConnectionsCommand[] = [];

  private disk: ConnectionsView;
  private region: ConnectionsView;
  private version = 0;
  private handlers: FrameHandler[] = [];
  private failures = new Map<ConnectionsCommand, Failure[]>();

  constructor(initial: ConnectionsView = { folders: [], connections: [] }) {
    this.disk = structuredClone(initial);
    this.region = structuredClone(initial);
  }

  // ── Test controls ────────────────────────────────────────────────────────────

  /**
   * Make the next call of `command` (for `options.id`, when given) fail with
   * `error`. With `options.partial`, part of the write reaches disk before the
   * failure (a later step of the same operation erroring).
   */
  failNext(command: ConnectionsCommand, error: unknown, options: FailureOptions = {}): void {
    const queue = this.failures.get(command) ?? [];
    queue.push({ error, ...options });
    this.failures.set(command, queue);
  }

  /** What is on disk now. */
  diskView(): ConnectionsView {
    return structuredClone(this.disk);
  }

  /** What the backend region holds now. */
  regionView(): ConnectionsView {
    return structuredClone(this.region);
  }

  /** The backend region's version (advances once per published fold). */
  regionVersion(): number {
    return this.version;
  }

  // ── Persist commands ─────────────────────────────────────────────────────────

  persistConnection = (connection: SavedConnection): Promise<void> =>
    this.commit(
      "persistConnection",
      (disk) => ({ folders: disk.folders, connections: upsert(disk.connections, connection) }),
      connection.id
    );

  removeConnection = (connectionId: string): Promise<void> =>
    this.commit(
      "removeConnection",
      (disk) => ({
        folders: disk.folders,
        connections: disk.connections.filter((c) => c.id !== connectionId),
      }),
      connectionId
    );

  persistFolder = (folder: ConnectionFolder): Promise<void> =>
    this.commit("persistFolder", (disk) => ({
      folders: upsert(disk.folders, folder),
      connections: disk.connections,
    }));

  removeFolder = (folderId: string): Promise<void> =>
    this.commit("removeFolder", (disk) => {
      const removed = disk.folders.find((f) => f.id === folderId);
      const parentId = removed?.parentId ?? null;
      return {
        folders: disk.folders
          .filter((f) => f.id !== folderId)
          .map((f) => (f.parentId === folderId ? { ...f, parentId } : f)),
        connections: disk.connections.map((c) =>
          c.folderId === folderId ? { ...c, folderId: null } : c
        ),
      };
    });

  reorderConnections = (connectionIds: string[]): Promise<void> =>
    this.commit("reorderConnections", (disk) => {
      const listed = connectionIds
        .map((id) => disk.connections.find((c) => c.id === id))
        .filter((c): c is SavedConnection => c !== undefined);
      const rest = disk.connections.filter((c) => !connectionIds.includes(c.id));
      return { folders: disk.folders, connections: [...listed, ...rest] };
    });

  moveConnectionToFile = async (
    connectionId: string,
    _currentSource: string | null,
    targetSource: string | null
  ): Promise<SavedConnection> => {
    await this.commit("moveConnectionToFile", (disk) => ({
      folders: disk.folders,
      connections: disk.connections.map((c) =>
        c.id === connectionId ? { ...c, sourceFile: targetSource } : c
      ),
    }));
    return structuredClone(this.disk.connections.find((c) => c.id === connectionId)!);
  };

  saveConnectionToFile = async (
    connection: SavedConnection,
    _currentSource: string | null
  ): Promise<SavedConnection> => {
    await this.commit("saveConnectionToFile", (disk) => ({
      folders: disk.folders,
      connections: upsert(disk.connections, connection),
    }));
    return structuredClone(connection);
  };

  /**
   * The `commit` choke point twin: apply `op` to disk (or the scheduled failure,
   * with its partial write), then fold disk into the region either way.
   */
  private commit(
    command: ConnectionsCommand,
    op: (disk: ConnectionsView) => ConnectionsView,
    id?: string
  ): Promise<void> {
    this.calls.push(command);
    const failure = this.takeFailure(command, id);
    if (failure) {
      if (failure.partial) this.disk = structuredClone(failure.partial(this.disk));
      this.fold();
      return Promise.reject(failure.error);
    }
    this.disk = structuredClone(op(this.disk));
    this.fold();
    return Promise.resolve();
  }

  /** Take the first scheduled failure of `command` that applies to `id`. */
  private takeFailure(command: ConnectionsCommand, id?: string): Failure | undefined {
    const queue = this.failures.get(command);
    const index = queue?.findIndex((f) => f.id === undefined || f.id === id) ?? -1;
    return index === -1 ? undefined : queue!.splice(index, 1)[0];
  }

  /** Publish disk into the region; the diff frame lands on a later macrotask. */
  private fold(): void {
    const ops = compare(this.region, this.disk) as DiffOp[];
    if (ops.length === 0) return;
    const baseVersion = this.version;
    this.version += 1;
    this.region = structuredClone(this.disk);
    const frame = {
      kind: "diff" as const,
      region: "connections",
      baseVersion,
      version: this.version,
      ops,
    };
    setTimeout(() => {
      for (const handler of this.handlers) handler(frame);
    }, 0);
  }

  // ── Transport ────────────────────────────────────────────────────────────────

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    return {
      intentId: intent.intentId,
      status: "rejected",
      error: { code: "unknown_kind", message: `no route for ${intent.kind}` },
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

  async resync(region: string, have?: number): Promise<SnapshotFrame | null> {
    return have === this.version ? null : this.snapshot(region);
  }

  private snapshot(region: string): SnapshotFrame {
    return { kind: "snapshot", region, version: this.version, view: this.regionView() };
  }
}

/** Replace the entry with the same id, or append it. */
function upsert<T extends { id: string }>(items: T[], item: T): T[] {
  return items.some((i) => i.id === item.id)
    ? items.map((i) => (i.id === item.id ? item : i))
    : [...items, item];
}
