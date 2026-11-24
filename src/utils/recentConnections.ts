import type { SavedConnection } from "@/types/connection";
import type { SessionHistoryEntry } from "@/types/sessionHistory";
import { sessionHistoryTitle } from "@/utils/sessionHistoryTitle";

/** How many saved connections the empty window offers as one-click buttons (#5856). */
export const RECENT_CONNECTION_LIMIT = 5;

/** The saved connections to offer first, and whether any was actually used before. */
export interface RecentConnections {
  /** At most {@link RECENT_CONNECTION_LIMIT} saved connections, most recently used first. */
  connections: SavedConnection[];
  /** True when at least one of them was used before. */
  fromHistory: boolean;
}

/** The session-history key a saved connection's terminals are recorded under. */
function historyKey(connection: SavedConnection): string {
  const type = connection.config.type;
  return `${type}\u0000${sessionHistoryTitle(type, connection.config)}`;
}

/**
 * Pick the saved connections the empty window offers (#5856, R-087): those
 * used most recently first, then the rest in sidebar order.
 *
 * A saved connection's recency is its own `lastUsedAt`, which the backend
 * stamps on each successful connect (#5940), so two saved connections to the
 * same `user@host` keep separate times.
 *
 * Connections with no stamp — never used since #5940, or kept in an external
 * file, which a connect never rewrites — fall back to the session history:
 * the newest entry with the same type and display title (`admin@prod-db`).
 * That fallback is skipped for a key that a stamped connection already
 * shares, because every connect also refreshes the history entry: the entry's
 * time belongs to the stamped twin, not to the unstamped one. The order is a
 * hint, never a filter.
 */
export function pickRecentConnections(
  connections: readonly SavedConnection[],
  history: readonly SessionHistoryEntry[],
  limit: number = RECENT_CONNECTION_LIMIT
): RecentConnections {
  const historyUsed = new Map<string, number>();
  for (const entry of history) {
    const key = `${entry.connectionType}\u0000${entry.title}`;
    historyUsed.set(key, Math.max(historyUsed.get(key) ?? 0, entry.lastUsed));
  }
  const stampedKeys = new Set(
    connections.filter((c) => (c.lastUsedAt ?? 0) > 0).map((c) => historyKey(c))
  );
  const ranked = connections.map((connection, index) => {
    const stamp = connection.lastUsedAt ?? 0;
    if (stamp > 0) return { connection, index, used: stamp };
    const key = historyKey(connection);
    const used = stampedKeys.has(key) ? 0 : (historyUsed.get(key) ?? 0);
    return { connection, index, used };
  });
  ranked.sort((a, b) => b.used - a.used || a.index - b.index);
  const picked = ranked.slice(0, Math.max(0, limit));
  return {
    connections: picked.map((r) => r.connection),
    fromHistory: picked.some((r) => r.used > 0),
  };
}
