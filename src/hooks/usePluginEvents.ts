import { useEffect } from "react";
import { useAppStore } from "@/store/appStore";
import { onPluginsChanged } from "@/services/events";

/**
 * Keep the store's plugin state in step with the backend plugin manager (#3344).
 *
 * The store's own plugin actions (install / enable / …) already re-fetch, but a
 * change made elsewhere — the native-plugin trust gate in Settings (#3296), or
 * another window — only announces itself through the backend `plugin-changed`
 * event. On each one, re-fetch the installed-plugin list and the connection-type
 * registry, so the sidebar's missing-plugin marker and the type selector update
 * live without a restart.
 */
export function usePluginEvents(): void {
  const loadPlugins = useAppStore((s) => s.loadPlugins);
  const refreshConnectionTypes = useAppStore((s) => s.refreshConnectionTypes);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;

    void onPluginsChanged(() => {
      void loadPlugins();
      void refreshConnectionTypes();
    }).then((off) => {
      if (disposed) off();
      else unlisten = off;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [loadPlugins, refreshConnectionTypes]);
}
