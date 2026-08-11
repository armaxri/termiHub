/**
 * `useProjectedFileBrowsers` — read the **authoritative** client-scoped
 * `file-browser@<clientId>` region (#2228, part of #2139 / #2153; reducer removal
 * #2283).
 *
 * The file-browser panel renders per-pane UI state: the active pane, each pane's
 * cwd / listing / loading / error, and the copy-cut clipboard. Since the reducer
 * removal (#2283) the `appStore` file-browser slice is gone, so this region is the
 * single source of truth: the `appStore` file-browser actions do the async list op
 * and report each transition through a granular `fileBrowser.*` intent, which the
 * bridge overlays optimistically and the backend `FileBrowserStore` confirms. The
 * direct analog of {@link import("./useProjectedSettings").useProjectedSettings}
 * (#2227) and {@link import("./useProjectedMonitors").useProjectedMonitors} (#2224).
 *
 * The hook subscribes to the region (one shared subscription, fanned out by the
 * bridge) and returns the latest projected view, re-rendering on every diff. It
 * seeds from {@link currentFileBrowsersView} so a consumer mounting after the first
 * diff already has the current picture, and from {@link EMPTY_FILE_BROWSERS_VIEW}
 * before any diff has arrived. There is no `appStore` fallback and no mirror gate —
 * the region is the source of truth.
 *
 * # Scope — the browser *view*, not the session model
 *
 * The projected view covers only the browser *view*: the active pane, each pane's
 * cwd / listing / list-operation loading+error, and the clipboard. The backend
 * session model — the live session id that gates `isConnected` and transfers —
 * stays an `appStore` read in the per-mode hooks; this hook does not touch it.
 */

import { useEffect, useState } from "react";

import {
  currentFileBrowsersView,
  ensureFileBrowsersSubscribed,
  logFileBrowsersBridgeFallback,
  onFileBrowsersView,
  type FileBrowsersView,
} from "@/store/fileBrowsersBridge";

/**
 * The effective file-browsers view for rendering — the active pane, the two panes
 * (local / session) and the clipboard — sourced from the authoritative
 * `file-browser@<clientId>` projection region.
 */
export function useProjectedFileBrowsers(): FileBrowsersView {
  const [view, setView] = useState<FileBrowsersView>(() => currentFileBrowsersView());

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = onFileBrowsersView((next) => {
      if (!cancelled) setView(next);
    });
    // `ensureFileBrowsersSubscribed` builds the transport eagerly, so a non-Tauri
    // env without a socket throws synchronously (not just a rejection) — guard both
    // so the hook silently stays on the last-known (or empty) view.
    try {
      ensureFileBrowsersSubscribed()
        .then(() => {
          if (!cancelled) setView(currentFileBrowsersView());
        })
        .catch((err) => logFileBrowsersBridgeFallback("subscribe", err));
    } catch (err) {
      logFileBrowsersBridgeFallback("subscribe", err);
    }
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return view;
}
