import type { ConnectionConfig } from "./terminal";

/**
 * A single recorded session in the browsable history.
 *
 * Mirrors the Rust `SessionHistoryEntry`. Passwords and key contents are never
 * stored — only connection metadata carried in {@link config}.
 */
export interface SessionHistoryEntry {
  /** Deduplication key (e.g. `ssh:admin@prod-db:22`). */
  dedupKey: string;
  /** Human-readable display title (e.g. `admin@prod-db`). */
  title: string;
  /** Connection type identifier (`ssh`, `serial`, `docker`, …). */
  connectionType: string;
  /** Connection configuration, same shape as a saved connection's config. */
  config: ConnectionConfig;
  /** When this session was first recorded (Unix timestamp, milliseconds). */
  firstUsed: number;
  /** When this session was last used (Unix timestamp, milliseconds). */
  lastUsed: number;
  /** Total number of times connected. */
  useCount: number;
  /** Whether the entry is pinned (exempt from automatic eviction). */
  pinned: boolean;
  /** Whether the entry has been promoted to a saved connection. */
  promoted: boolean;
}
