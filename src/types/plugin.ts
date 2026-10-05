/**
 * TypeScript types for the plugin system's frontend foundation.
 *
 * These mirror the Rust manifest model in `core/src/plugin/manifest.rs`
 * (serialized as camelCase JSON) and the plugin-system concept
 * (`docs/concepts/future/plugin-system.html`, impl §6). The `InstalledPlugin`
 * and `PluginState` types describe a plugin's install-time/runtime status as
 * surfaced by the `PluginManager` Tauri commands (concept §7); they have no
 * direct manifest analog.
 *
 * The DTOs below are generated from the Rust model, so they cannot drift.
 */

/**
 * A JSON value, mirroring `serde_json::Value`. Used for opaque manifest fields
 * (a plugin's `configSchema` and a setting's `default`) that the host stores
 * and forwards without interpreting.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * A JSON Schema object describing a plugin-provided backend's connection config.
 * Opaque to the host; the schema-driven config form consumes it in later work.
 *
 * @public Referenced by the ts-rs binding `generated/TerminalBackendExtension.ts`
 * (via `import("../plugin")`), which knip does not analyse.
 */
export type JsonSchema = { [key: string]: JsonValue };

// The plugin DTOs are generated from their Rust source of truth via ts-rs (audit
// DUP-030, ts-rs rollout #3088): the manifest, lifecycle, version/signer-change,
// update-check, trust-store and index types from core `core/src/plugin/` (behind
// core's `plugin` feature), and the command results from
// `src-tauri/src/commands/plugin{,_update,_index}.rs`. `JsonValue` / `JsonSchema`
// above stay hand-written; the generated manifest types reference them.
import type { PluginSignerChange } from "./generated/PluginSignerChange";
import type { PluginTrustInfo } from "./generated/PluginTrustInfo";
import type { PluginVersionChange } from "./generated/PluginVersionChange";

export type { PluginPermission } from "./generated/PluginPermission";
export type { PluginPlatform } from "./generated/PluginPlatform";
export type { TerminalBackendExtension } from "./generated/TerminalBackendExtension";
export type { ProtocolParserExtension } from "./generated/ProtocolParserExtension";
export type { ThemeEntry } from "./generated/ThemeEntry";
export type { ThemeExtension } from "./generated/ThemeExtension";
export type { WidgetPosition } from "./generated/WidgetPosition";
export type { StatusBarWidgetExtension } from "./generated/StatusBarWidgetExtension";
export type { PluginExtensions } from "./generated/PluginExtensions";
export type { PluginSettingType } from "./generated/PluginSettingType";
export type { PluginSettingSchema } from "./generated/PluginSettingSchema";
export type { PluginManifest } from "./generated/PluginManifest";
export type { PluginState } from "./generated/PluginState";
export type { InstalledPlugin } from "./generated/InstalledPlugin";
export type { InstallPluginResult } from "./generated/InstallPluginResult";
export type { PluginPackagePreview } from "./generated/PluginPackagePreview";
export type { TrustedPublisher } from "./generated/TrustedPublisher";
export type { NativePluginTrust } from "./generated/NativePluginTrust";
export type { PluginUpdateCheckOutcome } from "./generated/PluginUpdateCheckOutcome";
export type { PluginUpdateCheckResult } from "./generated/PluginUpdateCheckResult";
export type { PluginIndexEntryView } from "./generated/PluginIndexEntryView";
export type { PluginIndexResult } from "./generated/PluginIndexResult";
export type { PluginIndexSignatureStatus } from "./generated/PluginIndexSignatureStatus";
export type { PluginSignerChange, PluginTrustInfo, PluginVersionChange };

/**
 * What an install is waiting on the user to confirm before it can proceed.
 * `signer` and `version` may both be present — the dialog asks for both at once.
 */
export interface PluginInstallPendingConfirmation {
  /** A pending version change (PLG-012), or `null`. */
  version: PluginVersionChange | null;
  /** A pending publisher-key change (#3489), or `null`. */
  signer: PluginSignerChange | null;
}

/** The explicit confirmations to send with an install. */
export interface PluginInstallConfirmations {
  /** The user confirmed a downgrade / same-version rebuild / uncomparable version. */
  confirmVersionChange?: boolean;
  /** The user confirmed a publisher-key change or a removed signature. */
  confirmSignerChange?: boolean;
}

/**
 * A terminal-backend connection type contributed by an active plugin, projected
 * from installed plugins' `terminalBackend` extensions for the connection-type
 * selector. Mirrors the store shape in concept §10.
 */
export interface PluginBackendType {
  /** ID of the plugin providing this backend. */
  pluginId: string;
  /** The connection type it registers. */
  connectionType: string;
  /** Human-readable name shown in the selector. */
  displayName: string;
}

/**
 * Injected reader of a file inside an installed plugin's directory (`path`
 * relative to `plugins/<id>/`), returning the raw bytes. This is the shape of
 * the `readPluginFile` service wrapper; the theme and frontend-plugin loaders
 * take it as a dependency so their parse/register logic stays free of any
 * Tauri/IPC import and unit-testable.
 */
export type PluginFileReader = (pluginId: string, path: string) => Promise<Uint8Array>;
