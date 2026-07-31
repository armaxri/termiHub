/**
 * `useProjectedSettings` — the Settings screen cut to the projected `settings`
 * region (#2227 render cut, part of #2153 / #2139).
 *
 * The Settings screen renders the persisted `AppSettings` document (theme, fonts,
 * confirmation prompts, shell integration, editor mappings, …). Through the shadow
 * step the panels read `appStore.settings` directly. This hook makes them source
 * that document from the shared `settings` projection region instead — the direct
 * analog of {@link import("./useProjectedMonitors").useProjectedMonitors} (#2224)
 * and {@link import("./useProjectedAgents").useProjectedAgents} (#2226).
 *
 * # Safety (strangler)
 *
 * - **Gated** by {@link settingsRenderFromProjectionEnabled} (on by default). Flag
 *   off ⇒ the hook returns `appStore`'s settings document verbatim.
 * - **Faithful-mirror gate.** The projection sources the render only when it
 *   deep-equals the `appStore` document ({@link settingsViewMirrors}); otherwise
 *   the hook falls back to `appStore` (never a stale view). While `appStore` stays
 *   authoritative (the mutation cut is a later step) the region is kept a mirror by
 *   {@link seedSettingsRegion}, so it is always populated — making the cut
 *   parity-safe and independent of the mutation flag.
 */

import { useEffect, useMemo, useState } from "react";

import { useAppStore } from "@/store/appStore";
import {
  currentSettingsView,
  ensureSettingsSubscribed,
  logSettingsBridgeFallback,
  onSettingsView,
  seedSettingsRegion,
  settingsRenderFromProjectionEnabled,
  settingsViewMirrors,
  type SettingsView,
} from "@/store/settingsBridge";
import type { AppSettings } from "@/types/connection";

/**
 * The effective settings document for rendering: the persisted `AppSettings`
 * sourced from the projected `settings` region when it faithfully mirrors
 * `appStore`, otherwise `appStore`'s document verbatim (flag off, region not yet
 * caught up, or a transport that cannot subscribe).
 */
export function useProjectedSettings(): AppSettings {
  const settings = useAppStore((s) => s.settings);

  // Read the flag once at mount: it flips only via dev tooling, and the
  // subscription lifecycle is keyed off it below.
  const [enabled] = useState(() => settingsRenderFromProjectionEnabled());

  const [view, setView] = useState<SettingsView | undefined>(undefined);

  // Subscribe to the shared settings region while enabled; a transport that cannot
  // subscribe (non-Tauri without a socket) just leaves the UI on the appStore
  // fallback.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const unsubscribe = onSettingsView((next) => {
      if (!cancelled) setView(next);
    });
    // `ensureSettingsSubscribed` builds the transport eagerly, so a non-Tauri env
    // without a socket throws synchronously (not just a rejection) — guard both so
    // the UI silently stays on the appStore fallback.
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
  }, [enabled]);

  const matches = enabled && settingsViewMirrors(view, settings);

  // Keep the region a faithful mirror of appStore's document. Only once a view has
  // arrived (so we are subscribed) and it is not already a mirror; de-duped inside
  // `seedSettingsRegion` so a settled document is not re-seeded on every render.
  useEffect(() => {
    if (!enabled || matches || view === undefined) return;
    seedSettingsRegion(settings).catch((err) => logSettingsBridgeFallback("seed", err));
  }, [enabled, matches, view, settings]);

  return useMemo(() => {
    if (matches && view) return view;
    return settings;
  }, [matches, view, settings]);
}
