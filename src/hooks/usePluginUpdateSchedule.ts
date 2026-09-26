import { useEffect } from "react";
import { useAppStore } from "@/store/appStore";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import { hasUpdateSource, usePluginUpdateStore } from "@/plugins/pluginUpdateStore";

/** Delay before the first background check after startup / enabling. */
export const FIRST_PLUGIN_UPDATE_CHECK_DELAY_MS = 60_000;

/** Interval between background checks while the setting is on. */
export const PLUGIN_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * The opt-in periodic plugin update check (PROD-051).
 *
 * Does nothing unless Settings → Plugins → "Check for Plugin Updates
 * Automatically" (`pluginUpdateCheckEnabled`) is on — it is off by default — and
 * at least one installed plugin declares an `updateUrl`. Then it checks once a
 * minute after startup and every 24 hours after that. A check only records
 * "update available" for the Plugins view; it never downloads or installs.
 */
export function usePluginUpdateSchedule(): void {
  const enabled = useProjectedSettings().pluginUpdateCheckEnabled ?? false;
  const anyUpdatable = useAppStore((s) => s.plugins.some(hasUpdateSource));

  useEffect(() => {
    if (!enabled || !anyUpdatable) return;
    const run = () => void usePluginUpdateStore.getState().checkForUpdates();
    let interval: ReturnType<typeof setInterval> | null = null;
    const first = setTimeout(() => {
      run();
      interval = setInterval(run, PLUGIN_UPDATE_CHECK_INTERVAL_MS);
    }, FIRST_PLUGIN_UPDATE_CHECK_DELAY_MS);
    return () => {
      clearTimeout(first);
      if (interval !== null) clearInterval(interval);
    };
  }, [enabled, anyUpdatable]);
}
