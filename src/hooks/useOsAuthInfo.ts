import { useCallback, useEffect, useState } from "react";
import { getOsAuthInfo } from "@/services/api";
import { onCredentialStoreStatusChanged } from "@/services/events";
import { useAppStore } from "@/store/appStore";
import type { OsAuthInfo } from "@/types/credential";
import { frontendLog } from "@/utils/frontendLog";
import { errorMessage } from "@/utils/errorMessage";

/** Whether a value has the shape of an {@link OsAuthInfo}. */
function isOsAuthInfo(value: unknown): value is OsAuthInfo {
  return (
    typeof value === "object" &&
    value !== null &&
    "exportReauth" in value &&
    "biometricUnlock" in value
  );
}

/**
 * OS user-verification capabilities (Touch ID / Windows Hello) and the
 * biometric-unlock state (#3433, PROD-064).
 *
 * `info` is `null` until loaded (or when the query fails — callers treat that
 * as "not available", failing closed). It is re-read whenever the credential
 * store's mode or lock status changes or the backend reports a store change
 * (e.g. a master-password change drops biometric unlock), and `refresh`
 * re-reads it on demand.
 */
export function useOsAuthInfo(): { info: OsAuthInfo | null; refresh: () => Promise<void> } {
  const mode = useAppStore((s) => s.credentialStoreStatus?.mode);
  const status = useAppStore((s) => s.credentialStoreStatus?.status);
  const [info, setInfo] = useState<OsAuthInfo | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result: unknown = await getOsAuthInfo();
      setInfo(isOsAuthInfo(result) ? result : null);
    } catch (err) {
      frontendLog("credential", `Could not read OS authentication info: ${errorMessage(err)}`);
      setInfo(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, mode, status]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    // Deferred so a missing/failed event bridge lands in `catch` instead of
    // throwing during the effect.
    Promise.resolve()
      .then(() => onCredentialStoreStatusChanged(() => void refresh()))
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // Event bridge unavailable (tests / teardown) — the mode/status
        // dependency above still refreshes the info.
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refresh]);

  return { info, refresh };
}
