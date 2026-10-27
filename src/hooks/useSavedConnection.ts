import { useCallback, useSyncExternalStore } from "react";
import type { SavedConnection } from "@/types/connection";
import { currentConnectionsView, onConnectionsView } from "@/store/connectionsBridge";

/** Subscribe adapter: `onConnectionsView` passes the view, the store ignores it. */
function subscribe(onChange: () => void): () => void {
  return onConnectionsView(() => onChange());
}

/**
 * The saved connection with `id` from the authoritative `connections` region,
 * or `undefined` when `id` is unset or no longer exists. Used where only a
 * connection id is at hand — e.g. a tab rendering its connection's custom
 * icon, colour and emoji (#5008). Re-renders only when that connection's
 * object changes (the region view is cached between diffs).
 */
export function useSavedConnection(id: string | undefined): SavedConnection | undefined {
  const getSnapshot = useCallback(
    () => (id ? currentConnectionsView().connections.find((c) => c.id === id) : undefined),
    [id]
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}
