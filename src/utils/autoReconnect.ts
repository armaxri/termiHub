/**
 * The unified auto-reconnect connection setting (PARITY-008).
 *
 * Every connection type that supports automatic reconnect exposes it under one
 * settings key, `autoReconnect`, which defaults to **on** — an absent key means
 * "on". Mirrors `termihub_core::connection::auto_reconnect` on the Rust side.
 *
 * SSH historically used a separate `resilientReconnect` key (default off). The
 * backend rewrites that legacy key on read, but a config that never passed
 * through a backend read (e.g. an inline tab config restored from an older
 * workspace) may still carry it, so the reader falls back to it.
 */

/** The unified settings key for automatic reconnect. */
export const AUTO_RECONNECT_KEY = "autoReconnect";

/** The legacy SSH-only key, still honoured on read. */
export const LEGACY_RESILIENT_RECONNECT_KEY = "resilientReconnect";

/** Auto-reconnect is on unless the user explicitly turned it off. */
export const AUTO_RECONNECT_DEFAULT = true;

/**
 * Whether auto-reconnect is enabled for a connection settings bag: the unified
 * key if it holds a boolean, else the legacy key, else the default (on).
 */
export function isAutoReconnectEnabled(settings: Record<string, unknown> | undefined): boolean {
  const unified = settings?.[AUTO_RECONNECT_KEY];
  if (typeof unified === "boolean") return unified;
  const legacy = settings?.[LEGACY_RESILIENT_RECONNECT_KEY];
  if (typeof legacy === "boolean") return legacy;
  return AUTO_RECONNECT_DEFAULT;
}
