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
  /**
   * Multi-platform native libraries (PLG-011): Rust target triple → library
   * path inside the package. Absent for a legacy single-platform package.
   */
  libraries?: Record<string, string>;
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
  /**
   * Optional HTTPS URL of the plugin's update document (PROD-051). Enables the
   * opt-in "Check for updates"; it never installs anything by itself.
   */
  updateUrl?: string;
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
 * How an incoming plugin package relates to the installed copy of the same id
 * (PLG-012). Mirrors Rust `VersionChangeKind`.
 *
 * - `fresh` / `upgrade` / `reinstall` — install proceeds silently.
 * - `downgrade` — the incoming version is older than the installed one.
 * - `sameVersionChanged` — same version, but a different package build.
 * - `unverifiable` — a version is not valid semver, so the direction is unknown.
 */
export type PluginVersionChangeKind =
  | "fresh"
  | "upgrade"
  | "reinstall"
  | "sameVersionChanged"
  | "downgrade"
  | "unverifiable";

/** A version change that needs the user's confirmation. Mirrors Rust `VersionChange`. */
export interface PluginVersionChange {
  /** The plugin id being installed. */
  pluginId: string;
  /** Display name from the incoming manifest. */
  pluginName: string;
  /** The installed version, or `null` when it could not be read. */
  installedVersion: string | null;
  /** The incoming package's version. */
  incomingVersion: string;
  /** How the incoming package relates to the installed one. */
  kind: PluginVersionChangeKind;
}

/**
 * How the incoming package's signer relates to the signer of the installed copy
 * of the same id (#3489). Mirrors Rust `SignerChangeKind`.
 *
 * - `fresh` / `sameKey` / `newlySigned` / `stillUnsigned` — install proceeds.
 * - `keyChanged` — the installed copy was signed by a different key.
 * - `signatureRemoved` — the installed copy was signed; this package is not.
 * - `unverifiable` — the installed copy's signer could not be determined.
 */
export type PluginSignerChangeKind =
  | "fresh"
  | "sameKey"
  | "newlySigned"
  | "stillUnsigned"
  | "keyChanged"
  | "signatureRemoved"
  | "unverifiable";

/** A publisher-key change that needs the user's confirmation. Mirrors Rust `SignerChange`. */
export interface PluginSignerChange {
  /** The plugin id being installed. */
  pluginId: string;
  /** Display name from the incoming manifest. */
  pluginName: string;
  /** `sha256:` fingerprint of the key that signed the installed copy, or `null`. */
  installedKeyId: string | null;
  /** `sha256:` fingerprint of the key that signed the incoming package, or `null` if unsigned. */
  incomingKeyId: string | null;
  /** How the signers relate. */
  kind: PluginSignerChangeKind;
}

/**
 * Result of the `install_plugin` command: installed, or refused pending an
 * explicit confirmation — nothing was changed in either refusal case.
 *
 * - `confirmationRequired` — a downgrade / same-version rebuild / uncomparable
 *   version (PLG-012); re-issue with `confirmVersionChange`.
 * - `signerConfirmationRequired` — the publisher key changed or the signature
 *   was removed (#3489); re-issue with `confirmSignerChange`, and also with
 *   `confirmVersionChange` when `version` is present.
 */
export type InstallPluginResult =
  | { status: "installed"; plugin: InstalledPlugin }
  | { status: "confirmationRequired"; change: PluginVersionChange }
  | {
      status: "signerConfirmationRequired";
      signer: PluginSignerChange;
      version: PluginVersionChange | null;
    };

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

/**
 * A package's trust level, mirroring the backend `TrustLevel` / the
 * `PluginTrustInfo.level` string (concept "States & Sequences"):
 * - `untrusted` — no signature; requires the risk acknowledgement.
 * - `signed` — valid signature from a key not in the trust store (offer TOFU).
 * - `verified` — valid signature from a trusted (bundled or pinned) key.
 * - `tampered` — signature present but invalid; installation is blocked.
 */
export type PluginTrustLevel = "untrusted" | "signed" | "verified" | "tampered";

/**
 * A package's install preview returned by `preview_plugin` (#3507). Mirrors the
 * Rust `PluginPackagePreview`: the validated manifest plus whether it ships a
 * native library for this computer's platform (PLG-011). A package that lacks
 * this platform is previewed (not refused) so the dialog can explain why it
 * cannot be installed; the install itself is still refused by the backend.
 */
export interface PluginPackagePreview {
  /** The package's validated manifest. */
  manifest: PluginManifest;
  /** This computer's Rust target triple (e.g. `aarch64-apple-darwin`). */
  hostPlatform: string;
  /** Whether the package can be installed on this computer's platform. */
  platformSupported: boolean;
}

/**
 * The provenance/trust assessment of a `.termihub-plugin` package, mirroring the
 * Rust `PluginTrustInfo` returned by `assess_plugin_trust`. Drives the install
 * dialog's four-state provenance banner.
 */
export interface PluginTrustInfo {
  /** The assessed trust level. */
  level: PluginTrustLevel;
  /** User-facing warning (empty for a verified publisher). */
  warning: string;
  /** The signing key's `sha256:` fingerprint (signed/verified), else null. */
  keyId: string | null;
  /** The trusted publisher's label (verified only), else null. */
  publisher: string | null;
  /** Base64 of the signing public key (signed/verified), else null. */
  publicKey: string | null;
  /** Whether a trust affordance must be surfaced (risk ack / TOFU). */
  requiresAcceptance: boolean;
  /** Whether installation is hard-blocked (tampered), with no override. */
  isBlocked: boolean;
}

/** How a trusted publisher key came to be trusted. Mirrors Rust `TrustSource`. */
export type TrustSource = "bundled" | "user-pinned";

/**
 * A trusted publisher key in the trust store, mirroring Rust `TrustedPublisher`.
 * Listed in Settings → Plugins → Trusted Publishers.
 */
export interface TrustedPublisher {
  /** `sha256:` fingerprint — the store's primary key. */
  keyId: string;
  /** Base64 of the 32-byte Ed25519 public key. */
  publicKey: string;
  /** Human-readable label (publisher name / author). */
  label: string;
  /** Whether the key is bundled (immutable) or user-pinned (revocable). */
  source: TrustSource;
  /** RFC 3339 timestamp the key was added. */
  addedAt: string;
}

/**
 * One recorded native-plugin trust acknowledgment, mirroring Rust `NativeAckInfo`
 * (SEC-002 / PLG-006 / ARCH-008). The acknowledgment is bound to the exact
 * backend library hash, so a changed binary is no longer trusted.
 */
export interface NativeAckInfo {
  /** The plugin id this acknowledgment is for. */
  id: string;
  /** SHA-256 (hex) of the backend library the acknowledgment is bound to. */
  librarySha256: string;
  /** RFC 3339 timestamp the acknowledgment was recorded. */
  acknowledgedAt: string;
}

/**
 * The native-plugin trust state for Settings → Plugins, mirroring Rust
 * `NativePluginTrust`. Native (in-process) plugins are default-off and load only
 * after an explicit per-plugin acknowledgment (SEC-002 / PLG-006 / ARCH-008).
 */
export interface NativePluginTrust {
  /** Whether native (in-process) plugins are enabled globally (default false). */
  enabled: boolean;
  /** Plain-language disclosure to show before enabling/trusting a native plugin. */
  disclosure: string;
  /** Every recorded per-plugin acknowledgment, sorted by plugin id. */
  acknowledged: NativeAckInfo[];
}

/**
 * Whether an update check offers a newer version (mirrors Rust `UpdateStatus`):
 *
 * - `upToDate` — the published version is not newer (an older one is never offered).
 * - `updateAvailable` — a newer, host-compatible version can be downloaded.
 * - `incompatibleHost` — a newer version exists but needs a newer termiHub.
 */
export type PluginUpdateStatus = "upToDate" | "updateAvailable" | "incompatibleHost";

/** An evaluated update check for one plugin (Rust `UpdateCheckOutcome`). */
export interface PluginUpdateCheckOutcome {
  pluginId: string;
  installedVersion: string;
  latestVersion: string;
  status: PluginUpdateStatus;
  downloadUrl: string;
  sha256: string;
  minHostAbi: string;
  changelogUrl?: string;
}

/**
 * One plugin's result from `check_plugin_updates`: either an `outcome` or an
 * `error` explaining why the check failed (unreachable, invalid document, …).
 */
export interface PluginUpdateCheckResult {
  pluginId: string;
  outcome?: PluginUpdateCheckOutcome;
  error?: string;
}
