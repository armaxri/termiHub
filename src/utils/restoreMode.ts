/**
 * Startup session-restore mode: how the previously-open tabs are handled when
 * the app launches.
 *
 * - `"never"` — never restore; start with a fresh empty session.
 * - `"ask"` — show a dialog offering to restore the previous session.
 * - `"always"` — restore the previous session silently.
 */

import type { AppSettings } from "@/types/connection";
import type { LastSession } from "@/types/lastSession";
import type { WorkspaceTabDef } from "@/types/workspace";
import { getWorkspaceLeaves } from "@/utils/workspaceLayout";

/** The three restore modes. */
export type RestoreLastSessionMode = "never" | "ask" | "always";

/** A single restorable tab, described for the restore dialog. */
export interface RestoreTabInfo {
  /** Human-readable tab title. */
  title: string;
  /** Short connection-type label (e.g. "SSH", "Serial", "Local"). */
  typeLabel: string;
}

/** Summary of a stored last session for the restore dialog. */
export interface RestorePrompt {
  /** Total number of restorable tabs across all groups. */
  tabCount: number;
  /** Per-tab descriptors for display. */
  tabs: RestoreTabInfo[];
}

const VALID_MODES: readonly RestoreLastSessionMode[] = ["never", "ask", "always"];

/**
 * Resolve the effective restore mode from settings, migrating the legacy
 * boolean `restoreLastSessionOnStartup` when the explicit mode is unset.
 *
 * - explicit {@link AppSettings.restoreLastSessionMode} wins when valid;
 * - otherwise the legacy boolean `=== false` maps to `"never"`;
 * - otherwise the default is `"ask"` (the concept default).
 */
export function resolveRestoreMode(settings: AppSettings): RestoreLastSessionMode {
  const explicit = settings.restoreLastSessionMode;
  if (explicit && VALID_MODES.includes(explicit)) return explicit;
  if (settings.restoreLastSessionOnStartup === false) return "never";
  return "ask";
}

/** Map a stored tab definition's connection type to a short display label. */
function tabTypeLabel(tab: WorkspaceTabDef): string {
  if (tab.agentRef) return "Agent";
  const type = tab.inlineConfig?.type;
  switch (type) {
    case "ssh":
      return "SSH";
    case "serial":
      return "Serial";
    case "telnet":
      return "Telnet";
    case "docker":
      return "Docker";
    case "wsl":
      return "WSL";
    case "local":
      return "Local";
    default:
      return type ? type.charAt(0).toUpperCase() + type.slice(1) : "Terminal";
  }
}

/** Best-effort title for a stored tab when no explicit title was captured. */
function tabFallbackTitle(tab: WorkspaceTabDef): string {
  const cfg = tab.inlineConfig?.config as Record<string, unknown> | undefined;
  const host = typeof cfg?.host === "string" ? cfg.host : undefined;
  const user = typeof cfg?.username === "string" ? cfg.username : undefined;
  if (host) return user ? `${user}@${host}` : host;
  const device = typeof cfg?.device === "string" ? cfg.device : undefined;
  if (device) return device;
  return tabTypeLabel(tab);
}

/**
 * Flatten a stored {@link LastSession} into a per-tab summary for the restore
 * dialog. Pure over the session — no connection lookup, so it can run before
 * connections are loaded.
 */
export function summarizeLastSession(session: LastSession): RestorePrompt {
  const tabs: RestoreTabInfo[] = [];
  for (const group of session.tabGroups) {
    for (const leaf of getWorkspaceLeaves(group.layout)) {
      for (const tab of leaf.tabs) {
        tabs.push({
          title: tab.title?.trim() || tabFallbackTitle(tab),
          typeLabel: tabTypeLabel(tab),
        });
      }
    }
  }
  return { tabCount: tabs.length, tabs };
}
