/**
 * Presentation helpers shared by the Plugin Manager UI (#1997).
 *
 * Pure mappings from the plugin data model ({@link InstalledPlugin} and friends)
 * to icons, labels, and plain-language descriptions used by the sidebar list,
 * the detail panel, and the install dialog. Keeping these here (rather than
 * inline in the components) makes them unit-testable and keeps a single source
 * of truth for how a plugin's type/permissions/state are surfaced.
 */
import type { LucideIcon } from "lucide-react";
import {
  KeyRound,
  LayoutDashboard,
  Network,
  Palette,
  Puzzle,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  SlidersHorizontal,
} from "lucide-react";
import type {
  PluginExtensions,
  PluginManifest,
  PluginPermission,
  PluginState,
  PluginTrustInfo,
} from "@/types/plugin";

/** Coarse visual state of a plugin's status dot. */
export type PluginDotState = "enabled" | "disabled" | "error";

/**
 * Collapse the five install/runtime {@link PluginState}s into the three visual
 * dot states shown in the list and detail panel: green (enabled), grey
 * (disabled/installed), red (error/incompatible).
 */
export function pluginDotState(state: PluginState): PluginDotState {
  switch (state) {
    case "active":
      return "enabled";
    case "error":
    case "incompatible":
      return "error";
    default:
      return "disabled";
  }
}

/** Human-readable status word for a plugin state (detail-panel status pill). */
export function pluginStatusLabel(state: PluginState): string {
  switch (state) {
    case "active":
      return "Enabled";
    case "disabled":
    case "installed":
      return "Disabled";
    case "error":
      return "Error";
    case "incompatible":
      return "Incompatible";
  }
}

/**
 * Icon for a plugin, chosen from its primary (first-declared) extension point.
 * Terminal backends read as connections, themes as palettes, and so on; a plugin
 * with no recognised extension falls back to the generic puzzle piece.
 */
export function pluginTypeIcon(extensions: PluginExtensions): LucideIcon {
  if (extensions.terminalBackend) return Network;
  if (extensions.theme) return Palette;
  if (extensions.protocolParser) return SlidersHorizontal;
  if (extensions.statusBarWidget) return LayoutDashboard;
  return Puzzle;
}

/**
 * Short lower-case type label for the detail-panel meta line
 * (e.g. `terminal backend`). Picks the primary extension point.
 */
export function pluginTypeLabel(extensions: PluginExtensions): string {
  if (extensions.terminalBackend) return "terminal backend";
  if (extensions.theme) return "theme";
  if (extensions.protocolParser) return "protocol parser";
  if (extensions.statusBarWidget) return "status bar widget";
  return "plugin";
}

/** A single extension-point row for the detail panel's "Extension Points" list. */
export interface ExtensionPointInfo {
  /** Stable key for React lists. */
  key: string;
  icon: LucideIcon;
  /** The extension-point kind, e.g. "Terminal Backend". */
  label: string;
  /** Optional specifics (connection type, parser name, theme count). */
  detail?: string;
}

/**
 * Enumerate every extension point a plugin declares, in a stable order, for the
 * detail panel. Returns an empty array only for a manifest that declares none
 * (which the backend rejects at validation).
 */
export function extensionPoints(extensions: PluginExtensions): ExtensionPointInfo[] {
  const points: ExtensionPointInfo[] = [];
  if (extensions.terminalBackend) {
    points.push({
      key: "terminalBackend",
      icon: Network,
      label: "Terminal Backend",
      detail: extensions.terminalBackend.connectionType,
    });
  }
  if (extensions.protocolParser) {
    points.push({
      key: "protocolParser",
      icon: SlidersHorizontal,
      label: "Protocol Parser",
      detail: extensions.protocolParser.name,
    });
  }
  if (extensions.theme) {
    const count = extensions.theme.themes.length;
    points.push({
      key: "theme",
      icon: Palette,
      label: "Theme",
      detail: `${count} ${count === 1 ? "theme" : "themes"}`,
    });
  }
  if (extensions.statusBarWidget) {
    points.push({
      key: "statusBarWidget",
      icon: LayoutDashboard,
      label: "Status Bar Widget",
      detail: extensions.statusBarWidget.position,
    });
  }
  return points;
}

/** Title-case display name for a permission (e.g. `filesystem` → "FileSystem"). */
export const PERMISSION_LABELS: Record<PluginPermission, string> = {
  terminal: "Terminal",
  network: "Network",
  filesystem: "FileSystem",
  ui: "UI",
  settings: "Settings",
};

/**
 * Plain-language explanation of what each permission grants, shown beside the
 * permission name in the detail panel and the install prompt (concept
 * "Plugin Permissions").
 */
export const PERMISSION_DESCRIPTIONS: Record<PluginPermission, string> = {
  terminal: "create and manage terminal sessions",
  network: "make outbound network connections",
  filesystem: "read and write files (scoped to declared paths)",
  ui: "render UI components in designated slots",
  settings: "store and read plugin configuration",
};

/** True when the plugin declares at least one user-configurable setting. */
export function hasSettings(manifest: PluginManifest): boolean {
  return manifest.settings != null && Object.keys(manifest.settings).length > 0;
}

/**
 * Render a `sha256:`-prefixed key fingerprint truncated for display
 * (e.g. `sha256:ab12…9f0e`), so the full 64-hex digest does not dominate a
 * banner or settings row. Short or missing values are returned unchanged.
 */
export function fingerprintShort(keyId: string | null | undefined): string {
  if (!keyId) return "";
  const [scheme, hex] = keyId.split(":", 2);
  if (!hex || hex.length <= 12) return keyId;
  return `${scheme}:${hex.slice(0, 4)}…${hex.slice(-4)}`;
}

/** The colour tone of the install dialog's provenance banner. */
export type TrustBannerTone = "verified" | "warning" | "danger";

/** The presentation of the provenance banner for one trust level. */
export interface TrustBanner {
  tone: TrustBannerTone;
  icon: LucideIcon;
  /** Bold banner heading. */
  title: string;
  /** Supporting sentence (includes the truncated fingerprint where relevant). */
  description: string;
}

/**
 * Map a package's {@link PluginTrustInfo} to its provenance-banner presentation
 * (concept "Install gate, provenance banner states"): a green shield for a
 * verified publisher, an amber key for a signed-but-unknown one, an amber shield
 * for an unsigned package, and a red shield-x for a tampered one.
 */
export function trustBanner(trust: PluginTrustInfo): TrustBanner {
  const fp = fingerprintShort(trust.keyId);
  switch (trust.level) {
    case "verified":
      return {
        tone: "verified",
        icon: ShieldCheck,
        title: "Verified publisher",
        description: `signed by ${trust.publisher ?? "a trusted publisher"} (trusted). ${fp}`,
      };
    case "signed":
      return {
        tone: "warning",
        icon: KeyRound,
        title: "Signed — new publisher",
        description: `valid signature from an unrecognised key. ${fp}`,
      };
    case "tampered":
      return {
        tone: "danger",
        icon: ShieldX,
        title: "Signature invalid",
        description: trust.warning,
      };
    case "untrusted":
      return {
        tone: "warning",
        icon: ShieldAlert,
        title: "Untrusted source",
        description: trust.warning,
      };
  }
}
