/**
 * `useProjectedSettings` — read the authoritative `settings` region (#2227, part
 * of #2153 / #2139).
 *
 * The Settings screen and the settings-driven UI render the persisted `AppSettings`
 * document (theme, fonts, confirmation prompts, shell integration, editor mappings,
 * …). They source that document from the shared `settings` projection region, which
 * is now **authoritative**: the backend `SettingsStore` is fed at the source
 * (#2386) — the region is seeded from the persisted document at startup and every
 * `save_settings` folds the resolved document in — so the region is the single
 * source of truth. The direct analog of
 * {@link import("./useProjectedMonitors").useProjectedMonitors} (#2224) and
 * {@link import("./useProjectedTransfers").useProjectedTransfers} (#2229).
 *
 * The hook subscribes to the region (one shared subscription, fanned out by the
 * bridge) and returns the latest projected document, re-rendering on every diff. It
 * seeds from {@link currentSettingsView} so a consumer mounting after the first
 * diff already has the current picture, and from {@link DEFAULT_SETTINGS_VIEW}
 * before any diff has arrived. There is no `appStore` fallback and no mirror gate —
 * the region is the source of truth.
 */

import { useEffect, useState } from "react";

import {
  currentSettingsView,
  ensureSettingsSubscribed,
  logSettingsBridgeFallback,
  onSettingsView,
  type SettingsView,
} from "@/store/settingsBridge";
import type { AppSettings } from "@/types/connection";

/**
 * The current persisted settings document for rendering, sourced from the
 * authoritative `settings` projection region.
 */
export function useProjectedSettings(): AppSettings {
  const [view, setView] = useState<SettingsView>(() => currentSettingsView());

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = onSettingsView((next) => {
      if (!cancelled) setView(next);
    });
    // `ensureSettingsSubscribed` builds the transport eagerly, so a non-Tauri env
    // without a socket throws synchronously (not just a rejection) — guard both so
    // the hook silently stays on the last-known (or default) document.
    try {
      ensureSettingsSubscribed()
        .then(() => {
          if (!cancelled) setView(currentSettingsView());
        })
        .catch((err) => logSettingsBridgeFallback("subscribe", err));
    } catch (err) {
      logSettingsBridgeFallback("subscribe", err);
    }
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return view;
}
