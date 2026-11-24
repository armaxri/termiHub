import type { SavedConnection } from "@/types/connection";
import type { SessionHistoryEntry } from "@/types/sessionHistory";
import { sessionHistoryTitle } from "@/utils/sessionHistoryTitle";

/** How many saved connections the empty window offers as one-click buttons (#5856). */
export const RECENT_CONNECTION_LIMIT = 5;

/** The saved connections to offer first, and whether any was actually used before. */
export interface RecentConnections {
  /** At most {@link RECENT_CONNECTION_LIMIT} saved connections, most recently used first. */
  connections: SavedConnection[];
  /** True when at least one of them was found in the session history. */
  fromHistory: boolean;
}

/**
 * Pick the saved connections the empty window offers (#5856, R-087): those
 * opened most recently first, then the rest in sidebar order.
 *
 * Saved connections carry no "last used" time of their own. Every terminal a
 * saved connection opens is recorded in the session history, though, keyed by
 * type and display title (`admin@prod-db`), so a connection's recency is the
 * newest history entry with the same type and title. Two saved connections to
 * the same `user@host` share it; the order is a hint, never a filter.
 */
export function pickRecentConnections(
  connections: readonly SavedConnection[],
  history: readonly SessionHistoryEntry[],
  limit: number = RECENT_CONNECTION_LIMIT
): RecentConnections {
  const lastUsed = new Map<string, number>();
  for (const entry of history) {
    const key = `${entry.connectionType}\u0000${entry.title}`;
    lastUsed.set(key, Math.max(lastUsed.get(key) ?? 0, entry.lastUsed));
  }
  const ranked = connections.map((connection, index) => {
    const type = connection.config.type;
    const key = `${type}\u0000${sessionHistoryTitle(type, connection.config)}`;
    return { connection, index, used: lastUsed.get(key) ?? 0 };
  });
  ranked.sort((a, b) => b.used - a.used || a.index - b.index);
  const picked = ranked.slice(0, Math.max(0, limit));
  return {
    connections: picked.map((r) => r.connection),
    fromHistory: picked.some((r) => r.used > 0),
  };
}
