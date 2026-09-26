import { useCallback, useEffect, useState } from "react";
import { listNamedCredentials, NAMED_CREDENTIALS_CHANGED_EVENT } from "@/services/namedCredentials";
import type { NamedCredentialEntry } from "@/types/generated/NamedCredentialEntry";
import { frontendLog } from "@/utils/frontendLog";

/** Result of {@link useNamedCredentials}. */
export interface UseNamedCredentialsResult {
  /** Every named credential with its users; empty until loaded. */
  entries: NamedCredentialEntry[];
  /** Whether the first load has finished (successfully or not). */
  loaded: boolean;
  /** Re-read the list from the backend. */
  refresh: () => Promise<void>;
}

/**
 * The shared named credentials (#3557), kept current across the app: every
 * create / rename / rotate / delete fires a window event that re-reads them.
 */
export function useNamedCredentials(): UseNamedCredentialsResult {
  const [entries, setEntries] = useState<NamedCredentialEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const list = await listNamedCredentials();
      setEntries(Array.isArray(list) ? list : []);
    } catch (err) {
      frontendLog("named_credentials", `Failed to list shared credentials: ${String(err)}`);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onChange = () => void refresh();
    window.addEventListener(NAMED_CREDENTIALS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(NAMED_CREDENTIALS_CHANGED_EVENT, onChange);
  }, [refresh]);

  return { entries, loaded, refresh };
}
