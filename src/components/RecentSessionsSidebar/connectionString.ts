import type { SessionHistoryEntry } from "@/types/sessionHistory";

/**
 * A copyable connection string for a history entry. The dedup key already
 * encodes the connection target (`ssh:user@host:port`, `docker:container:agent`,
 * …); strip the leading `type:` prefix so the copied value is the bare target
 * (`user@host:port`).
 */
export function connectionString(entry: SessionHistoryEntry): string {
  const prefix = `${entry.connectionType}:`;
  return entry.dedupKey.startsWith(prefix) ? entry.dedupKey.slice(prefix.length) : entry.dedupKey;
}
