/**
 * Pure presentation helpers for the native-plugin sandbox status in Settings →
 * Plugins (#4188, concept `docs/concepts/backlog/plugin-os-sandbox.html`,
 * "UI Interface" and "Failure modes"). They turn the `plugin-sandbox` region
 * row (plus the installed-plugin record) into the badge, process line, access
 * chips and warning copy the row renders, so every state is unit-testable
 * without rendering.
 */

import type { PluginSandboxStatus, PluginSandboxView } from "@/store/pluginSandboxBridge";
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
  /** Something no native plugin may ever do: rendered struck through. */
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
};

/** What each layer restricts, for the "This system cannot restrict …" copy. */
const LAYER_RESTRICTS: Record<string, string> = {
  landlock: "file access",
  seccomp: "network and program access",
  seatbelt: "file, network and program access",
  appcontainer: "file and network access",
  "job-object": "memory and program limits",
};

/** The display name of a sandbox layer. */
export function layerName(layer: string): string {
  return LAYER_NAMES[layer] ?? layer;
}

/**
 * The plain-language warning for reduced isolation (concept callout E): names
 * what this system cannot restrict and which layer is missing.
 */
export function missingLayerWarning(missing: string[]): string {
  if (missing.length === 0) return "This system cannot apply every sandbox layer.";
  const restricts = missing.map((l) => LAYER_RESTRICTS[l] ?? l).join(" and ");
  const names = missing.map(layerName).join(", ");
  const verb = missing.length === 1 ? "is" : "are";
  const stillApplies = missing.includes("landlock")
    ? " Network and program limits still apply."
    : "";
  return `This system cannot restrict ${restricts} (${names} ${verb} unavailable).${stillApplies}`;
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
 * is nothing to say (an untrusted plugin, or a sandboxed build that has not
 * tried to load it yet).
 */
export function isolationBadge(
  plugin: InstalledPlugin,
  status: PluginSandboxStatus | undefined,
  view: PluginSandboxView,
  trusted: boolean
): IsolationBadge | undefined {
  const disabled = autoDisabledReason(plugin, status);
  if (disabled) return { kind: "disabled", tone: "error", label: disabled };
  if (!trusted) return undefined;
  if (!view.outOfProcess) {
    return {
      kind: "notSandboxed",
      tone: "checking",
      label: "Not sandboxed",
      detail:
        "This build runs native plugins inside termiHub, without an operating-system sandbox.",
    };
  }
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
 * The access summary (concept callout D), derived from the manifest
 * permissions: what the plugin may reach through termiHub, and what no native
 * plugin may ever do (struck through).
 */
export function accessChips(plugin: InstalledPlugin): AccessChip[] {
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
  }
  chips.push({
    id: "data",
    label: "Own data folder",
    rule: "Read and write in its private data folder",
    denied: false,
  });
  if (permissions.includes("filesystem") && filesystemPaths && filesystemPaths.length > 0) {
    chips.push({
      id: "declared-files",
      label: "Declared folders",
      rule: `Through termiHub only: ${filesystemPaths.join(", ")}`,
      denied: false,
    });
  }
  chips.push({
    id: "files",
    label: "Your files",
    rule: "No access to your home folder or other files",
    denied: true,
  });
  chips.push({
    id: "programs",
    label: "Run programs",
    rule: "Cannot start other programs",
    denied: true,
  });
  return chips;
}
