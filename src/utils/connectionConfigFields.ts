import type { ConnectionConfig } from "@/types/terminal";

/**
 * Typed, runtime-checked accessors for the schema-driven settings bag on a
 * {@link ConnectionConfig} (FEC-008 / WA-FE-003).
 *
 * A connection's per-type settings live in `ConnectionConfig.config`, an
 * unstructured `Record<string, unknown>` because the concrete field set is
 * driven by the backend's JSON schemas (`DynamicForm`) and differs per
 * connection type. That untyped bag previously forced call sites to reach in
 * with unsafe casts (`config.config as unknown as Record<string, unknown>`,
 * `cfg.host as string`, …), which silence the compiler without adding any real
 * safety.
 *
 * These helpers replace those casts with genuine narrowing: each reader checks
 * the runtime type of the field and returns `undefined` when it is absent or of
 * the wrong type. Callers get a real `string` / `boolean` / `number` (or
 * `undefined`) rather than an unchecked assertion.
 *
 * A full discriminated union of the per-type config shapes — which would need to
 * mirror the Rust DTOs and stay in lockstep with them — is deliberately deferred
 * (see the FEC-008 follow-up and DUP-030, the TS↔Rust codegen tracker). Until a
 * generated union exists, these accessors are the safe, drift-free way to read
 * the bag.
 */

/**
 * The raw type-specific settings bag, or an empty object when no config is
 * present. Prefer the typed readers below for individual fields; use this only
 * when spreading/copying the whole bag.
 */
export function connectionConfigFields(
  config: ConnectionConfig | undefined | null
): Record<string, unknown> {
  return config?.config ?? {};
}

/** Read a config field as a `string`, or `undefined` when absent / not a string. */
export function readConfigString(
  config: ConnectionConfig | undefined | null,
  key: string
): string | undefined {
  const value = connectionConfigFields(config)[key];
  return typeof value === "string" ? value : undefined;
}

/** Read a config field as a `boolean`, or `undefined` when absent / not a boolean. */
export function readConfigBoolean(
  config: ConnectionConfig | undefined | null,
  key: string
): boolean | undefined {
  const value = connectionConfigFields(config)[key];
  return typeof value === "boolean" ? value : undefined;
}

/** Read a config field as a `number`, or `undefined` when absent / not a number. */
export function readConfigNumber(
  config: ConnectionConfig | undefined | null,
  key: string
): number | undefined {
  const value = connectionConfigFields(config)[key];
  return typeof value === "number" ? value : undefined;
}

/**
 * The host a connection targets, or `""` when its type declares none. Byte-based
 * backends (local shell, serial, …) carry no `host`; SSH/telnet/RDP-style types
 * do. A convenience wrapper over {@link readConfigString} for the common case.
 */
export function connectionConfigHost(config: ConnectionConfig | undefined | null): string {
  return readConfigString(config, "host") ?? "";
}
