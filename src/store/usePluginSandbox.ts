/**
 * `usePluginSandbox` — read the authoritative `plugin-sandbox` region (#4188).
 *
 * Returns the latest projected view (each native plugin's isolation, runner
 * process state and recent bridge denials), re-rendering on every diff. Seeds
 * from the last view so a consumer mounting after the first diff already has
 * the current picture; outside Tauri it stays on the empty view.
 */

import { useEffect, useState } from "react";

import {
  currentPluginSandboxView,
  ensurePluginSandboxSubscribed,
  logPluginSandboxBridge,
  onPluginSandboxView,
  type PluginSandboxView,
} from "@/store/pluginSandboxBridge";

/** The current `plugin-sandbox` view. */
export function usePluginSandbox(): PluginSandboxView {
  const [view, setView] = useState<PluginSandboxView>(() => currentPluginSandboxView());

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = onPluginSandboxView((next) => {
      if (!cancelled) setView(next);
    });
    try {
      ensurePluginSandboxSubscribed()
        .then(() => {
          if (!cancelled) setView(currentPluginSandboxView());
        })
        .catch((err) => logPluginSandboxBridge("subscribe", err));
    } catch (err) {
      logPluginSandboxBridge("subscribe", err);
    }
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return view;
}
