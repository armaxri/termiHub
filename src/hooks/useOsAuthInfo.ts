import { useCallback, useEffect, useState } from "react";
import { getOsAuthInfo } from "@/services/api";
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
 * store's mode or lock status changes, and `refresh` re-reads it on demand.
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

  return { info, refresh };
}
