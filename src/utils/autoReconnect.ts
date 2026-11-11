/**
 * The unified auto-reconnect connection setting (PARITY-008).
 *
 * Every connection type that supports automatic reconnect exposes it under one
 * settings key, `autoReconnect`. An absent key means the per-type default: on
 * for SSH and serial, off for telnet (#5390). Mirrors
 * `termihub_core::connection::auto_reconnect` on the Rust side.
 *
 * SSH historically used a separate `resilientReconnect` key (default off). The
 * backend rewrites that legacy key on read, but a config that never passed
 * through a backend read (e.g. an inline tab config restored from an older
 * workspace) may still carry it, so the reader falls back to it.
 */

/** The unified settings key for automatic reconnect. */
const AUTO_RECONNECT_KEY = "autoReconnect";

/** The legacy SSH-only key, still honoured on read. */
const LEGACY_RESILIENT_RECONNECT_KEY = "resilientReconnect";

/** Auto-reconnect is on unless the user explicitly turned it off. */
const AUTO_RECONNECT_DEFAULT = true;

/**
 * The connection types whose terminal tabs auto-reconnect into the same tab
 * after a drop (#5390). Twin of the Rust `TERMINAL_AUTO_RECONNECT_TYPES`.
 */
export const TERMINAL_AUTO_RECONNECT_TYPES: readonly string[] = ["ssh", "serial", "telnet"];

/**
 * What an absent `autoReconnect` key means for a connection type (#5390):
 * telnet is opt-in (off), every other type — SSH, serial, graphical — is on.
 * Twin of the Rust `auto_reconnect_default_for`.
 */
export function autoReconnectDefaultFor(connectionType: string | undefined): boolean {
  return connectionType === "telnet" ? false : AUTO_RECONNECT_DEFAULT;
}

/**
 * Whether auto-reconnect is enabled for a connection settings bag: the unified
 * key if it holds a boolean, else the legacy key, else the per-type default
 * ({@link autoReconnectDefaultFor}; on when no type is given).
 */
export function isAutoReconnectEnabled(
  settings: Record<string, unknown> | undefined,
  connectionType?: string
): boolean {
  const unified = settings?.[AUTO_RECONNECT_KEY];
  if (typeof unified === "boolean") return unified;
  const legacy = settings?.[LEGACY_RESILIENT_RECONNECT_KEY];
  if (typeof legacy === "boolean") return legacy;
  return autoReconnectDefaultFor(connectionType);
}
