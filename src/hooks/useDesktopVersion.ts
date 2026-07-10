import { useEffect, useState } from "react";
import { getAppInfo } from "@/services/api";
import { frontendLog } from "@/utils/frontendLog";

/**
 * Module-level cache so the desktop version is fetched at most once per session
 * and shared across every consumer (agent badges, status-bar summary).
 */
let cachedVersion: string | null = null;
let inflight: Promise<string> | null = null;

/**
 * Return the running desktop app version (e.g. `0.1.0`), or `null` until the
 * one-time {@link getAppInfo} fetch resolves. Used to derive each agent's
 * update state against the version the desktop expects.
 */
export function useDesktopVersion(): string | null {
  const [version, setVersion] = useState<string | null>(cachedVersion);

  useEffect(() => {
    if (cachedVersion !== null) {
      setVersion(cachedVersion);
      return;
    }
    let active = true;
    // Wrapped in try/catch so a failed or unavailable IPC degrades to a hidden
    // badge (version stays null / "unknown") instead of crashing the tree.
    const load = async () => {
      try {
        if (!inflight) {
          inflight = getAppInfo().then((info) => {
            cachedVersion = info.version;
            return info.version;
          });
        }
        const v = await inflight;
        if (active) setVersion(v);
      } catch (err) {
        inflight = null;
        frontendLog("use_desktop_version", `Failed to fetch app info: ${err}`);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, []);

  return version;
}
