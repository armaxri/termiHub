import { useEffect, useState } from "react";
import { getPluginHostPlatform } from "@/services/api";
import { frontendLog } from "@/utils/frontendLog";

/**
 * Module-level cache: this computer's target triple never changes during a
 * session, so it is fetched at most once and shared by every consumer.
 */
let cachedPlatform: string | null = null;
let inflight: Promise<string> | null = null;

/** Reset the module cache. Test-only. */
export function resetPluginHostPlatformCache(): void {
  cachedPlatform = null;
  inflight = null;
}

/**
 * Return this computer's Rust target triple (as plugin native libraries are
 * keyed, PLG-011), or `null` until the one-time fetch resolves or when it
 * fails — consumers then simply do not mark a "this computer" entry (#3507).
 */
export function usePluginHostPlatform(): string | null {
  const [platform, setPlatform] = useState<string | null>(cachedPlatform);

  useEffect(() => {
    if (cachedPlatform !== null) {
      setPlatform(cachedPlatform);
      return;
    }
    let active = true;
    const load = async () => {
      try {
        if (!inflight) {
          inflight = getPluginHostPlatform().then((fetched) => {
            cachedPlatform = fetched;
            return fetched;
          });
        }
        const loaded = await inflight;
        if (active) setPlatform(loaded);
      } catch (err) {
        inflight = null;
        frontendLog("use_plugin_host_platform", `Failed to fetch host platform: ${err}`);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, []);

  return platform;
}
