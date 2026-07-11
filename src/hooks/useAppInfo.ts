import { useEffect, useState } from "react";
import { getAppInfo, type AppInfo } from "@/services/api";
import { frontendLog } from "@/utils/frontendLog";

/**
 * Module-level cache so build-time app info is fetched at most once per session
 * and shared across every consumer (About/Update settings, status-bar version
 * chip, update notification, agent badges).
 */
let cachedInfo: AppInfo | null = null;
let inflight: Promise<AppInfo> | null = null;

/**
 * Return the running desktop app's build info ({@link AppInfo}), or `null`
 * until the one-time {@link getAppInfo} fetch resolves. The result is cached at
 * module scope, so mounting any number of consumers triggers the underlying IPC
 * call at most once per session.
 */
export function useAppInfo(): AppInfo | null {
  const [info, setInfo] = useState<AppInfo | null>(cachedInfo);

  useEffect(() => {
    if (cachedInfo !== null) {
      setInfo(cachedInfo);
      return;
    }
    let active = true;
    // Wrapped in try/catch so a failed or unavailable IPC degrades to a null
    // info (hidden badge / "—" version) instead of crashing the tree.
    const load = async () => {
      try {
        if (!inflight) {
          inflight = getAppInfo().then((fetched) => {
            cachedInfo = fetched;
            return fetched;
          });
        }
        const loaded = await inflight;
        if (active) setInfo(loaded);
      } catch (err) {
        inflight = null;
        frontendLog("use_app_info", `Failed to fetch app info: ${err}`);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, []);

  return info;
}

/**
 * Return just the running desktop app version (e.g. `0.1.0`), or `null` until
 * the shared {@link useAppInfo} fetch resolves. Thin wrapper kept for the
 * agent-badge / status-bar consumers that only need the version string.
 */
export function useDesktopVersion(): string | null {
  return useAppInfo()?.version ?? null;
}

/**
 * Reset the cached app info and any in-flight fetch.
 * Exposed for testing only.
 */
export function resetAppInfoCache(): void {
  cachedInfo = null;
  inflight = null;
}
