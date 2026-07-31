/**
 * `useProjectedFileBrowsers` — the file-browser panel cut to the projected
 * client-scoped `file-browser@<clientId>` region (#2228 render cut, part of #2139
 * and #2153).
 *
 * The file-browser panel renders per-pane UI state: the active pane, each pane's
 * cwd / listing / loading / error, and the copy-cut clipboard. Through the shadow
 * step it reads `appStore`'s file-browser slice (`fileBrowserMode`, the per-mode
 * `*FileEntries` / `*CurrentPath` / `*FileLoading` / `*FileError`, `fileClipboard`)
 * directly. This hook makes it source that slice from the client-scoped
 * `file-browser@<clientId>` projection region instead — the direct analog of
 * {@link import("./useProjectedBroadcast").useProjectedBroadcast} (#2242) and
 * {@link import("./useProjectedConnections").useProjectedConnections} (#2225).
 *
 * # Scope — the browser *view*, not the SFTP session model (#2236)
 *
 * The projected view mirrors only the browser *view*: the active pane, each pane's
 * cwd / listing / list-operation loading+error, and the clipboard. The backend
 * SFTP/session model — the SFTP connect status, the live session ids that gate
 * `isConnected`, and transfers — stays an `appStore` read in the per-mode hooks;
 * this hook does not touch it. The SFTP pane's `loading`/`error` mirrored here are
 * the frontend's own derived list flags (`sftpStatus`-derived + `sftpError`),
 * carried through the region verbatim so the render is a pure parity swap.
 *
 * # Safety (strangler)
 *
 * - **Gated** by {@link fileBrowsersRenderFromProjectionEnabled} (on by default).
 *   Flag off ⇒ the hook returns `appStore`'s slice verbatim.
 * - **Faithful-mirror gate.** The projection sources the render only when it
 *   deep-equals the `appStore` slice ({@link fileBrowsersViewMirrors}); otherwise
 *   the hook falls back to `appStore` (never a stale view). While `appStore` stays
 *   authoritative (the mutation cut is a later step) the region is kept a mirror by
 *   {@link seedFileBrowsersRegion}, so it is always populated — making the cut
 *   parity-safe and independent of the mutation flag.
 */

import { useEffect, useMemo, useState } from "react";

import { useAppStore } from "@/store/appStore";
import {
  currentFileBrowsersView,
  ensureFileBrowsersSubscribed,
  fileBrowsersRenderFromProjectionEnabled,
  fileBrowsersViewMirrors,
  logFileBrowsersBridgeFallback,
  onFileBrowsersView,
  seedFileBrowsersRegion,
  type FileBrowsersView,
} from "@/store/fileBrowsersBridge";

/**
 * The effective file-browsers slice for rendering: the active pane, the three
 * panes (local / sftp / session) and the clipboard, sourced from the projected
 * `file-browser@<clientId>` region when it faithfully mirrors `appStore`, otherwise
 * `appStore`'s slice verbatim (flag off, region not yet caught up, or a transport
 * that cannot subscribe).
 */
export function useProjectedFileBrowsers(): FileBrowsersView {
  const mode = useAppStore((s) => s.fileBrowserMode);

  const localEntries = useAppStore((s) => s.localFileEntries);
  const localPath = useAppStore((s) => s.localCurrentPath);
  const localLoading = useAppStore((s) => s.localFileLoading);
  const localError = useAppStore((s) => s.localFileError);

  const sftpEntries = useAppStore((s) => s.fileEntries);
  const sftpPath = useAppStore((s) => s.currentPath);
  const sftpStatus = useAppStore((s) => s.sftpStatus);
  const sftpError = useAppStore((s) => s.sftpError);

  const sessionEntries = useAppStore((s) => s.sessionFileEntries);
  const sessionPath = useAppStore((s) => s.sessionCurrentPath);
  const sessionLoading = useAppStore((s) => s.sessionFileLoading);
  const sessionError = useAppStore((s) => s.sessionFileError);

  const clipboard = useAppStore((s) => s.fileClipboard);

  // The `appStore`-shaped slice, matching the Rust region view model one-to-one.
  // The SFTP pane's `loading` mirrors `useFileSystem`'s derived flag exactly.
  const slice = useMemo<FileBrowsersView>(
    () => ({
      mode,
      local: { path: localPath, entries: localEntries, loading: localLoading, error: localError },
      sftp: {
        path: sftpPath,
        entries: sftpEntries,
        loading: sftpStatus === "connecting" || sftpStatus === "listing",
        error: sftpError,
      },
      session: {
        path: sessionPath,
        entries: sessionEntries,
        loading: sessionLoading,
        error: sessionError,
      },
      clipboard,
    }),
    [
      mode,
      localPath,
      localEntries,
      localLoading,
      localError,
      sftpPath,
      sftpEntries,
      sftpStatus,
      sftpError,
      sessionPath,
      sessionEntries,
      sessionLoading,
      sessionError,
      clipboard,
    ]
  );

  // Read the flag once at mount: it flips only via dev tooling, and the
  // subscription lifecycle is keyed off it below.
  const [enabled] = useState(() => fileBrowsersRenderFromProjectionEnabled());

  const [view, setView] = useState<FileBrowsersView | undefined>(undefined);

  // Subscribe to the client-scoped file-browsers region while enabled; a transport
  // that cannot subscribe (non-Tauri without a socket) just leaves the UI on the
  // appStore fallback.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const unsubscribe = onFileBrowsersView((next) => {
      if (!cancelled) setView(next);
    });
    // `ensureFileBrowsersSubscribed` builds the transport eagerly, so a non-Tauri
    // env without a socket throws synchronously (not just a rejection) — guard both
    // so the UI silently stays on the appStore fallback.
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
  }, [enabled]);

  const matches = enabled && fileBrowsersViewMirrors(view, slice);

  // Keep the region a faithful mirror of appStore's slice. Only once a view has
  // arrived (so we are subscribed) and it is not already a mirror; de-duped inside
  // `seedFileBrowsersRegion` so a settled slice is not re-seeded on every render.
  useEffect(() => {
    if (!enabled || matches || view === undefined) return;
    seedFileBrowsersRegion(slice).catch((err) => logFileBrowsersBridgeFallback("seed", err));
  }, [enabled, matches, view, slice]);

  return useMemo(() => {
    if (matches && view) return view;
    return slice;
  }, [matches, view, slice]);
}
