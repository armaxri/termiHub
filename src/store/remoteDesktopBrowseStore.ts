/**
 * The File Browser sources opened by "Browse remote files" on remote-desktop
 * tabs (#4193, concept `vnc-clipboard-file-transfer` phase 3).
 *
 * A VNC tab has no file browser of its own; "Browse remote files" registers
 * the session's file side channel with the backend (under the graphical
 * session id) and records it here, keyed by the tab. While that tab is active
 * the File Browser sidebar shows the side channel through the ordinary session
 * pane; the route line names the host. The entry lives until the graphical
 * session closes. Session-only, never persisted.
 */

import { create } from "zustand";
import type { FileSideChannel } from "@/types/generated/FileSideChannel";

/** One remote-desktop tab's side-channel browser. */
export interface RemoteDesktopBrowseSource {
  /** The graphical session id the backend registered the side channel under. */
  sessionId: string;
  /** The route, file host, account and same-host verdict (the route line). */
  channel: FileSideChannel;
  /** The folder to show: where Browse / Reveal asked to open. */
  dir: string;
  /** Bumped on every open, so asking for the same folder again re-navigates. */
  openCount: number;
}

interface RemoteDesktopBrowseState {
  /** Open sources, keyed by remote-desktop tab id. */
  sources: Record<string, RemoteDesktopBrowseSource>;
  /** Record (or refresh) the source of `tabId`. */
  openSource: (tabId: string, source: Omit<RemoteDesktopBrowseSource, "openCount">) => void;
  /** Update the route of an open source without re-navigating (a reconnect). */
  refreshSource: (tabId: string, channel: FileSideChannel) => void;
  /** Forget the source of `tabId`. */
  closeSource: (tabId: string) => void;
}

export const useRemoteDesktopBrowseStore = create<RemoteDesktopBrowseState>((set) => ({
  sources: {},
  openSource: (tabId, source) =>
    set((s) => ({
      sources: {
        ...s.sources,
        [tabId]: { ...source, openCount: (s.sources[tabId]?.openCount ?? 0) + 1 },
      },
    })),
  refreshSource: (tabId, channel) =>
    set((s) => {
      const current = s.sources[tabId];
      if (!current) return s;
      return { sources: { ...s.sources, [tabId]: { ...current, channel } } };
    }),
  closeSource: (tabId) =>
    set((s) => {
      if (!(tabId in s.sources)) return s;
      const sources = { ...s.sources };
      delete sources[tabId];
      return { sources };
    }),
}));

/** The source whose side channel is registered under `sessionId`, if any. */
export function browseSourceForSession(
  sources: Record<string, RemoteDesktopBrowseSource>,
  sessionId: string | null
): RemoteDesktopBrowseSource | null {
  if (!sessionId) return null;
  return Object.values(sources).find((s) => s.sessionId === sessionId) ?? null;
}
