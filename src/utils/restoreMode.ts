/**
 * Startup session-restore mode: how the previously-open tabs are handled when
 * the app launches.
 *
 * - `"never"` — never restore; start with a fresh empty session.
 * - `"ask"` — show a dialog offering to restore the previous session.
 * - `"always"` — restore the previous session silently.
 */

import type { AppSettings, SavedConnection } from "@/types/connection";
import type { LastSession } from "@/types/lastSession";
import type { WorkspaceLayoutNode, WorkspaceTabDef, WorkspaceTabGroupDef } from "@/types/workspace";
import { getWorkspaceLeaves } from "@/utils/workspaceLayout";

/** The three restore modes. */
export type RestoreLastSessionMode = "never" | "ask" | "always";

/**
 * Reachability of a restorable tab's connection target, resolved by an
 * asynchronous probe after the restore dialog opens.
 *
 * - `"reachable"` — the target answered (host port open / serial device present).
 * - `"unreachable"` — the target is down (host unreachable / device offline);
 *   the dialog flags it with a warning icon.
 * - `"unknown"` — not probed or the probe was inconclusive (the default before
 *   the probe resolves, and for targets with nothing meaningful to probe).
 */
export type RestoreReachability = "reachable" | "unreachable" | "unknown";

/**
 * The connection target derived from a stored tab, used to drive the
 * reachability probe. `kind` selects how the probe checks it; `local` and
 * `agent` targets are not network-probed (they resolve to `"unknown"`).
 */
export interface RestoreTabTarget {
  /** How the tab connects, selecting the reachability check to run. */
  kind: "host" | "serial" | "local" | "agent";
  /** Target host for `host` targets (SSH/telnet). */
  host?: string;
  /** Target TCP port for `host` targets. */
  port?: number;
  /** Serial device path for `serial` targets. */
  device?: string;
  /** Remote agent id for `agent` targets. */
  agentId?: string;
}

/** A single restorable tab, described for the restore dialog. */
export interface RestoreTabInfo {
  /** Human-readable tab title. */
  title: string;
  /** Short connection-type label (e.g. "SSH", "Serial", "Local"). */
  typeLabel: string;
  /**
   * The probe target derived from the stored tab. Optional so display-only
   * callers (and tests) need not construct it; {@link summarizeLastSession}
   * always populates it so the reachability probe can run.
   */
  target?: RestoreTabTarget;
  /**
   * Reachability of {@link target}, set asynchronously once the probe resolves.
   * Absent until then (treated as `"unknown"`).
   */
  reachability?: RestoreReachability;
  /**
   * Short human-readable reason shown beside the warning icon when the target is
   * unreachable (e.g. `"device offline"`, `"host unreachable"`).
   */
  unreachableReason?: string;
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

/** Default TCP ports for host-based connection types, used when unspecified. */
const DEFAULT_HOST_PORTS: Record<string, number> = { ssh: 22, telnet: 23 };

/**
 * Resolve a stored tab's effective connection type and config, following a
 * `connectionRef` into the supplied saved connections when present. Returns
 * `undefined` when neither an inline config nor a resolvable reference exists.
 */
function resolveTabConfig(
  tab: WorkspaceTabDef,
  connections: SavedConnection[]
): { type: string; config: Record<string, unknown> } | undefined {
  if (tab.inlineConfig) return tab.inlineConfig;
  if (tab.connectionRef) {
    const saved = connections.find((c) => c.id === tab.connectionRef);
    if (saved) {
      return { type: saved.config.type, config: saved.config.config as Record<string, unknown> };
    }
  }
  return undefined;
}

/**
 * Derive the reachability {@link RestoreTabTarget} for a stored tab. Host-based
 * types (SSH/telnet) yield a `host` target; serial yields a `serial` target;
 * agent references yield an `agent` target; everything else (local, docker,
 * WSL, unresolved refs) is `local` and is not network-probed.
 */
function deriveTabTarget(tab: WorkspaceTabDef, connections: SavedConnection[]): RestoreTabTarget {
  if (tab.agentRef) return { kind: "agent", agentId: tab.agentRef.agentId };

  const resolved = resolveTabConfig(tab, connections);
  const type = resolved?.type;
  const config = resolved?.config ?? {};

  if (type === "ssh" || type === "telnet") {
    const host = typeof config.host === "string" ? config.host : undefined;
    if (host) {
      const port = typeof config.port === "number" ? config.port : DEFAULT_HOST_PORTS[type];
      return { kind: "host", host, port };
    }
  }

  if (type === "serial") {
    const device =
      typeof config.device === "string"
        ? config.device
        : typeof config.port === "string"
          ? config.port
          : undefined;
    if (device) return { kind: "serial", device };
  }

  return { kind: "local" };
}

/**
 * Flatten a stored {@link LastSession} into a per-tab summary for the restore
 * dialog. Iterates groups → leaves → tabs in a stable order; that same order is
 * the tab index space used by {@link filterSessionBySelection}.
 *
 * `connections` (optional) lets `connectionRef` tabs resolve their host/serial
 * target for the reachability probe; pass the loaded connections when available.
 */
export function summarizeLastSession(
  session: LastSession,
  connections: SavedConnection[] = []
): RestorePrompt {
  const tabs: RestoreTabInfo[] = [];
  for (const group of session.tabGroups) {
    for (const leaf of getWorkspaceLeaves(group.layout)) {
      for (const tab of leaf.tabs) {
        tabs.push({
          title: tab.title?.trim() || tabFallbackTitle(tab),
          typeLabel: tabTypeLabel(tab),
          target: deriveTabTarget(tab, connections),
        });
      }
    }
  }
  return { tabCount: tabs.length, tabs };
}

/**
 * Prune a stored {@link LastSession} down to the tabs the user chose to restore.
 *
 * `selected` holds the flat tab indices to keep, in the same order
 * {@link summarizeLastSession} produced. Leaves left with no tabs are dropped,
 * splits collapse when only one child survives (redistributing sizes), and tab
 * groups whose layout empties out are removed. `activeGroupIndex` is remapped to
 * the surviving group nearest the original active one; `windows` are preserved
 * untouched (an emptied window still round-trips, per #1902).
 */
export function filterSessionBySelection(
  session: LastSession,
  selected: ReadonlySet<number>
): LastSession {
  let flatIndex = 0;

  const filterNode = (node: WorkspaceLayoutNode): WorkspaceLayoutNode | null => {
    if (node.type === "leaf") {
      const tabs = node.tabs.filter(() => selected.has(flatIndex++));
      return tabs.length > 0 ? { ...node, tabs } : null;
    }

    const keptChildren: WorkspaceLayoutNode[] = [];
    const keptOriginalIndices: number[] = [];
    node.children.forEach((child, i) => {
      const filtered = filterNode(child);
      if (filtered) {
        keptChildren.push(filtered);
        keptOriginalIndices.push(i);
      }
    });

    if (keptChildren.length === 0) return null;
    if (keptChildren.length === 1) return keptChildren[0];

    let sizes = node.sizes;
    if (sizes) {
      const chosen = keptOriginalIndices.map((i) => sizes?.[i] ?? 0);
      const total = chosen.reduce((a, b) => a + b, 0);
      sizes = total > 0 ? chosen.map((s) => (s / total) * 100) : undefined;
    }
    return { ...node, children: keptChildren, ...(sizes ? { sizes } : {}) };
  };

  const groups: WorkspaceTabGroupDef[] = [];
  const keptGroupIndices: number[] = [];
  session.tabGroups.forEach((group, i) => {
    const layout = filterNode(group.layout);
    if (layout) {
      groups.push({ ...group, layout });
      keptGroupIndices.push(i);
    }
  });

  // Remap the active group to a surviving one: the same group if it survived,
  // otherwise the nearest surviving group at or after it, else the first.
  let activeGroupIndex = 0;
  if (keptGroupIndices.length > 0) {
    const exact = keptGroupIndices.indexOf(session.activeGroupIndex);
    if (exact >= 0) {
      activeGroupIndex = exact;
    } else {
      const after = keptGroupIndices.findIndex((i) => i >= session.activeGroupIndex);
      activeGroupIndex = after >= 0 ? after : keptGroupIndices.length - 1;
    }
  }

  return { ...session, tabGroups: groups, activeGroupIndex };
}
