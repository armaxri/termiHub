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
 * Keep these in lockstep with the Rust model — no `any`, per the repo TS rules.
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
 */
export type JsonSchema = { [key: string]: JsonValue };

/**
 * A coarse-grained capability a plugin requests in its manifest.
 * Closed set — mirrors Rust `PluginPermission` (lowercase).
 */
export type PluginPermission = "terminal" | "network" | "filesystem" | "ui" | "settings";

/** A desktop platform a plugin declares support for. Mirrors Rust `Platform`. */
export type PluginPlatform = "windows" | "linux" | "macos";

/** A terminal-backend extension point. Mirrors Rust `TerminalBackendExtension`. */
export interface TerminalBackendExtension {
  /** The connection type this backend registers. */
  connectionType: string;
  /** Human-readable name shown in the connection-type selector. */
  displayName: string;
  /** JSON Schema describing the backend's connection config. */
  configSchema: JsonSchema;
}

/** A protocol-parser extension point. Mirrors Rust `ProtocolParserExtension`. */
export interface ProtocolParserExtension {
  /** Parser identifier. */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Path to the JS entry point within the package. */
  entryPoint: string;
}

/** A single theme provided by a {@link ThemeExtension}. Mirrors Rust `ThemeEntry`. */
export interface ThemeEntry {
  /** Theme identifier (unique within the plugin). */
  id: string;
  /** Display name. */
  name: string;
  /** Path to the theme JSON file within the package's `themes/` directory. */
  file: string;
}

/** A theme extension point. Mirrors Rust `ThemeExtension`. */
export interface ThemeExtension {
  /** The themes provided by this plugin. */
  themes: ThemeEntry[];
}

/** Which side of the status bar a widget renders on. Mirrors Rust `WidgetPosition`. */
export type WidgetPosition = "left" | "right";

/** A status-bar-widget extension point. Mirrors Rust `StatusBarWidgetExtension`. */
export interface StatusBarWidgetExtension {
  /** Path to the JS entry point within the package. */
  entryPoint: string;
  /** Where the widget is placed. */
  position: WidgetPosition;
}

/**
 * The `extensions` object: which extension points a plugin provides.
 * Mirrors Rust `PluginExtensions`; each field is optional and a valid plugin
 * declares at least one.
 */
export interface PluginExtensions {
  /** A new connection type with full terminal I/O (Rust dynamic library). */
  terminalBackend?: TerminalBackendExtension;
  /** An output filter that transforms or annotates terminal output (JS). */
  protocolParser?: ProtocolParserExtension;
  /** One or more custom color themes (JSON data). */
  theme?: ThemeExtension;
  /** A widget rendered into the status bar (JS). */
  statusBarWidget?: StatusBarWidgetExtension;
}

/** The primitive type of a plugin setting. Mirrors Rust `SettingType`. */
export type PluginSettingType = "string" | "number" | "boolean";

/**
 * The schema for a single plugin setting (`settings.<key>`).
 * Mirrors Rust `PluginSettingSchema`.
 */
export interface PluginSettingSchema {
  /** The setting's primitive type. */
  type: PluginSettingType;
  /** Default value applied when the user has not set one. */
  default: JsonValue;
  /** Human-readable description shown in the settings UI. */
  description: string;
  /** Optional closed set of allowed string values. */
  enum?: string[];
}

/**
 * The parsed contents of a plugin's `manifest.json`.
 * Mirrors Rust `PluginManifest` exactly (camelCase JSON keys).
 */
export interface PluginManifest {
  /** Stable, filesystem-safe identifier (used as the install directory name). */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Plugin version string (informational; the host does not interpret it). */
  version: string;
  /** Plugin author. */
  author: string;
  /** Short description. */
  description: string;
  /** SPDX-style license identifier. */
  license: string;
  /** Declared plugin-API version, as `"major.minor"`. */
  apiVersion: string;
  /** Desktop platforms the plugin supports. */
  platforms: PluginPlatform[];
  /** Coarse-grained permissions the plugin requests. */
  permissions: PluginPermission[];
  /**
   * Filesystem paths the plugin is scoped to. Only meaningful with the
   * `filesystem` permission — the host confines the plugin's filesystem access
   * to these roots. Absent/empty when the plugin requests no filesystem access.
   */
  filesystemPaths?: string[];
  /** The extension points the plugin provides. */
  extensions: PluginExtensions;
  /** Optional user-configurable settings, keyed by setting name. */
  settings?: Record<string, PluginSettingSchema>;
}

/**
 * An installed plugin's install-time/runtime status.
 *
 * - `installed` — present but not yet activated.
 * - `active` — loaded and its extension points are registered.
 * - `disabled` — installed but deactivated by the user.
 * - `error` — activation failed; see {@link InstalledPlugin.errorMessage}.
 * - `incompatible` — targets an unsupported plugin-API version.
 */
export type PluginState = "installed" | "active" | "disabled" | "error" | "incompatible";

/** An installed plugin as reported by the `PluginManager` (concept §6/§7). */
export interface InstalledPlugin {
  /** The plugin's validated manifest. */
  manifest: PluginManifest;
  /** Current install/runtime state. */
  state: PluginState;
  /** Failure detail when {@link InstalledPlugin.state} is `error`. */
  errorMessage?: string;
  /** ISO-8601 timestamp of when the plugin was installed. */
  installedAt: string;
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
