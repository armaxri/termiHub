import { useCallback } from "react";
import { SavedConnection } from "@/types/connection";
import { connectSavedConnection } from "@/utils/connectSavedConnection";

/** Return value of {@link useConnectSavedConnection}. */
export interface UseConnectSavedConnection {
  /**
   * Open a terminal tab for a saved connection, resolving credentials from the
   * credential store (and prompting when needed) exactly as the sidebar does.
   */
  connect: (connection: SavedConnection) => Promise<void>;
}

/**
 * Shared saved-connection connect flow for the sidebar {@link ConnectionList}
 * and the command palette — a thin hook over {@link connectSavedConnection},
 * which also serves scheduled runs' unattended connects (#3527), so the
 * credential logic lives in exactly one place.
 *
 * This hook intentionally contains no UI: callers own any surrounding
 * confirmation (e.g. the sidebar's insecure-FTP warning) and render the shared
 * `PasswordPrompt` / `UnlockDialog` that this flow drives through the store.
 */
export function useConnectSavedConnection(): UseConnectSavedConnection {
  const connect = useCallback(async (connection: SavedConnection) => {
    await connectSavedConnection(connection);
  }, []);

  return { connect };
}
