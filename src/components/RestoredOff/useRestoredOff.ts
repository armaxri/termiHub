import { useCallback, useEffect, useState } from "react";
import { listRestoredOff } from "@/services/api";
import type { RestoredStart } from "@/types/backup";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";

/** What the last restores left switched off, until it is dealt with (#6056). */
export function useRestoredOff(enabled = true) {
  const [entries, setEntries] = useState<RestoredStart[]>([]);
  const reload = useCallback(async (): Promise<RestoredStart[]> => {
    try {
      const listed = await listRestoredOff();
      const next = Array.isArray(listed) ? listed : [];
      setEntries(next);
      return next;
    } catch (err) {
      frontendLog("restored_off", `Failed to list what was restored off: ${errorMessage(err)}`);
      return [];
    }
  }, []);
  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);
  return { entries, setEntries, reload };
}
