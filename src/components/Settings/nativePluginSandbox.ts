/**
 * Pure presentation helpers for the native-plugin sandbox status in Settings →
 * Plugins (#4188, concept `docs/concepts/implemented/plugin-os-sandbox.html`,
 * "UI Interface" and "Failure modes"). They turn the `plugin-sandbox` region
 * row (plus the installed-plugin record) into the badge, process line, access
 * chips and warning copy the row renders, so every state is unit-testable
 * without rendering.
 */

import type { PluginSandboxStatus } from "@/store/pluginSandboxBridge";
import type { InstalledPlugin } from "@/types/plugin";

/** The tone of a status indicator (maps to `settings-panel__status-indicator--*`). */
export type IndicatorTone = "ok" | "warning" | "error" | "checking";

/** Which isolation badge a row shows. */
export type IsolationBadgeKind =
  | "isolated"
  | "reduced"
  | "unavailable"
  | "notSandboxed"
  | "failed"
  | "runnerMissing"
  | "disabled";

/** The isolation badge of one row. */
export interface IsolationBadge {
  kind: IsolationBadgeKind;
  tone: IndicatorTone;
  label: string;
  /** Hover help / extra detail, if any. */
  detail?: string;
}

/** One access chip (concept callout D). */
export interface AccessChip {
  id: string;
  label: string;
  /** The exact rule, shown on hover. */
  rule: string;
  /** Something the plugin cannot do: rendered struck through. */
  denied: boolean;
}

/** The host default for concurrent bridge connections (core `DEFAULT_MAX_CONNECTIONS`). */
const DEFAULT_MAX_CONNECTIONS = 8;

/** Human names of the sandbox layers, for the "missing layer" copy. */
const LAYER_NAMES: Record<string, string> = {
  landlock: "Linux Landlock",
  seccomp: "Linux seccomp",
  seatbelt: "macOS Seatbelt",
  appcontainer: "Windows AppContainer",
  "job-object": "Windows job object",
  netns: "Linux network namespace",
};

/** What each layer restricts, for the "This system cannot restrict …" copy. */
const LAYER_RESTRICTS: Record<string, string> = {
  landlock: "file access",
  seccomp: "network and program access",
  seatbelt: "file, network and program access",
  appcontainer: "file and network access",
  "job-object": "memory and program limits",
  netns: "network interfaces",
};

/** The display name of a sandbox layer. */
export function layerName(layer: string): string {
  return LAYER_NAMES[layer] ?? layer;
}

/** Linux-only sandbox layers: their presence in a status row means a Linux host. */
const LINUX_LAYERS = new Set(["landlock", "seccomp", "netns"]);

/** Whether a status row comes from a Linux host (any Linux layer enforced or missing). */
function isLinuxSandbox(status: Pick<PluginSandboxStatus, "enforced" | "missing">): boolean {
  return [...status.enforced, ...status.missing].some((l) => LINUX_LAYERS.has(l));
}

/**
 * What a plugin can still do to the user's files when Landlock is missing
 * (#4605, matching #4342's sandbox): the namespace layer masks the home folder,
 * otherwise nothing stops it from changing the user's files — startup scripts
 * included, which amounts to running programs as the user.
 */
function landlockMissingConsequence(enforced: string[]): string {
  return enforced.includes("netns")
    ? "Your home folder stays hidden, but the plugin can read and change other files on this system."
    : "The plugin can read and change any of your files, including startup scripts, so it can effectively run programs as you.";
}

/**
 * The plain-language warning for reduced isolation (concept callout E): names
 * what this system cannot restrict and which layer is missing, and — for a
 * missing Landlock — what the plugin can then reach, which depends on whether
 * the namespace layer is among the `enforced` layers (#4605).
 */
export function missingLayerWarning(missing: string[], enforced: string[] = []): string {
  if (missing.length === 0) return "This system cannot apply every sandbox layer.";
  const restricts = missing.map((l) => LAYER_RESTRICTS[l] ?? l).join(" and ");
  const names = missing.map(layerName).join(", ");
  const verb = missing.length === 1 ? "is" : "are";
  const consequence = missing.includes("landlock")
    ? ` ${landlockMissingConsequence(enforced)}`
    : "";
  return `This system cannot restrict ${restricts} (${names} ${verb} unavailable).${consequence}`;
}

/** Whether an installed plugin was auto-disabled after repeated crashes. */
export function autoDisabledReason(
  plugin: InstalledPlugin,
  status: PluginSandboxStatus | undefined
): string | undefined {
  if (status?.process?.autoDisabled) return status.process.autoDisabled;
  if (plugin.state === "disabled" && plugin.errorMessage) return plugin.errorMessage;
  return undefined;
}

/**
 * The isolation badge for a trusted native plugin, or `undefined` when there
 * is nothing to say (an untrusted plugin, or one the host has not tried to
 * load yet). Every native plugin runs in a sandboxed process (ADR-19).
 */
export function isolationBadge(
  plugin: InstalledPlugin,
  status: PluginSandboxStatus | undefined,
  trusted: boolean
): IsolationBadge | undefined {
  const disabled = autoDisabledReason(plugin, status);
  if (disabled) return { kind: "disabled", tone: "error", label: disabled };
  if (!trusted) return undefined;
  switch (status?.isolation) {
    case "full":
      return {
        kind: "isolated",
        tone: "ok",
        label: "Isolated",
        detail: `Enforced: ${status.enforced.map(layerName).join(", ")}`,
      };
    case "reduced":
      return { kind: "reduced", tone: "warning", label: "Reduced isolation (accepted)" };
    case "unconfined":
      return {
        kind: "notSandboxed",
        tone: "checking",
        label: "Not sandboxed",
        detail: "This system has no plugin sandbox yet; the plugin runs in its own process.",
      };
    case "unavailable":
      return {
        kind: "unavailable",
        tone: "warning",
        label: "Isolation unavailable on this system",
      };
    case "failed":
      return {
        kind: "failed",
        tone: "error",
        label: "Could not start the plugin sandbox",
        detail: status.detail,
      };
    case "runnerMissing":
      return {
        kind: "runnerMissing",
        tone: "error",
        label: "Plugin runner is missing — reinstall termiHub",
        detail: status.detail,
      };
    default:
      return undefined;
  }
}

/** The process line (concept callout C), or `undefined` when there is none. */
export function processLabel(status: PluginSandboxStatus | undefined): string | undefined {
  const process = status?.process;
  if (!process) return undefined;
  const restarts = `${process.crashes}/${process.maxRestarts}`;
  switch (process.state) {
    case "running": {
      const parts = ["Running"];
      if (process.sessions > 0) {
        parts.push(`${process.sessions} ${process.sessions === 1 ? "session" : "sessions"}`);
      }
      if (process.crashes > 0) parts.push(`restarted ${restarts}`);
      return parts.join(" · ");
    }
    case "restarting":
      return `Restarting (${restarts})`;
    case "idle":
      return "Idle";
    case "disabled":
      return undefined;
  }
}

/**
 * The "files" chip: what the plugin can reach outside its own folders. Off
 * Linux (or before the sandbox reports) the OS sandbox denies it outright. On
 * Linux it depends on the layers #4342 enforces (#4605):
 * - Landlock + namespace layer: denied, and the masked home folder hides even
 *   file names;
 * - Landlock only: contents denied, but `stat` is not mediated, so file names
 *   and sizes stay visible;
 * - namespace layer only (reduced): the home folder is hidden, other files are
 *   readable and writable;
 * - neither (reduced, Yama-guarded): any of the user's files is reachable.
 */
function filesChip(hasDeclared: boolean, status: PluginSandboxStatus | undefined): AccessChip {
  const id = "files";
  const label = hasDeclared ? "Other files" : "Your files";
  // Declared folders may lie inside the home folder, so the denial must not
  // claim the home folder is out of reach (#4293).
  const scope = hasDeclared
    ? "files outside the declared folders"
    : "your home folder or other files";
  const linux = status !== undefined && isLinuxSandbox(status);
  const landlock = linux && status.enforced.includes("landlock");
  const netns = linux && status.enforced.includes("netns");
  if (!linux || (landlock && netns)) {
    return { id, label, rule: `No access to ${scope}`, denied: true };
  }
  if (landlock) {
    return {
      id,
      label,
      rule: `Cannot open ${scope}, but can see their names and sizes`,
      denied: true,
    };
  }
  if (netns) {
    return {
      id,
      label,
      rule: "Your home folder stays hidden; other files on this system can be read and changed",
      denied: false,
    };
  }
  return { id, label, rule: "Can read and change any of your files", denied: false };
}

/**
 * The access summary (concept callout D), derived from the manifest
 * permissions and — for what the OS sandbox actually enforces — the plugin's
 * `plugin-sandbox` status: what the plugin may reach through termiHub, and
 * what it cannot do (struck through).
 */
export function accessChips(plugin: InstalledPlugin, status?: PluginSandboxStatus): AccessChip[] {
  const { permissions, filesystemPaths, connectionPolicy } = plugin.manifest;
  const chips: AccessChip[] = [];
  if (permissions.includes("network")) {
    const max = connectionPolicy?.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    chips.push({
      id: "network",
      label: "Network via termiHub",
      rule: `Outbound TCP only through termiHub, max ${max} connections`,
      denied: false,
    });
    // Loopback and private ranges are refused unless the manifest opts in
    // (SEC2-005); cloud metadata addresses are refused either way.
    chips.push(
      connectionPolicy?.allowLocalNetwork
        ? {
            id: "local-network",
            label: "Local network",
            rule: "May reach this computer (localhost) and private networks; cloud metadata stays blocked",
            denied: false,
          }
        : {
            id: "local-network",
            label: "Local network",
            rule: "Cannot reach this computer (localhost) or private networks",
            denied: true,
          }
    );
  }
  chips.push({
    id: "data",
    label: "Own data folder",
    rule: "Read and write in its private data folder",
    denied: false,
  });
  const declared =
    permissions.includes("filesystem") && filesystemPaths && filesystemPaths.length > 0
      ? filesystemPaths
      : [];
  if (declared.length > 0) {
    chips.push({
      id: "declared-files",
      label: "Declared folders",
      // One folder per line, so every granted path is visible as declared.
      rule: ["Through termiHub only:", ...declared].join("\n"),
      denied: false,
    });
  }
  chips.push(filesChip(declared.length > 0, status));
  chips.push({
    id: "programs",
    label: "Run programs",
    rule: "Cannot start other programs",
    denied: true,
  });
  return chips;
}
