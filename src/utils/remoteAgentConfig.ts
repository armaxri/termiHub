import type { ConnectionConfig } from "@/types/terminal";
import type { ExternalAgentFile } from "@/types/generated/ExternalAgentFile";
import type { RemoteAgentConfig } from "@/types/generated/RemoteAgentConfig";
import type { UpdateStrategy } from "@/types/generated/UpdateStrategy";
import { readConfigBoolean, readConfigNumber, readConfigString } from "./connectionConfigFields";

/**
 * Validated conversions between the connection editor's form settings bag and
 * the generated {@link RemoteAgentConfig} DTO (FEC-008 follow-up #3162).
 *
 * The remote-agent SSH transport is *not* a backend connection type — its form
 * is rendered from the static `AGENT_SCHEMA`, so the editor holds its state as
 * an unstructured `Record<string, unknown>` like every other schema-driven
 * form. Moving between that bag and the `RemoteAgentConfig` DTO (a ts-rs type
 * with **no** index signature, mirroring `core/src/config` / the Rust source of
 * truth) previously used `as unknown as` erasures in both directions.
 *
 * These helpers replace those erasures with genuine, field-by-field
 * conversions: {@link toRemoteAgentConfig} reads each field with a runtime type
 * check (via the shared `connectionConfigFields` accessors), and
 * {@link remoteAgentConfigToRecord} is its inverse. Every DTO field is carried
 * across both directions so an edit-then-save round-trip never silently drops a
 * field the form does not render (e.g. `agentPath`, `externalConnectionFiles`).
 *
 * A fully generated union that removes the hand-mirroring entirely is the
 * separate TS↔Rust codegen track (DUP-030).
 */

/** Narrow an unknown value to the `RemoteAgentConfig.authMethod` union, defaulting to `"password"`. */
function toAuthMethod(value: unknown): RemoteAgentConfig["authMethod"] {
  return value === "key" || value === "agent" || value === "password" ? value : "password";
}

/** Narrow an unknown value to the {@link UpdateStrategy} union, or `undefined` when absent/invalid. */
function toUpdateStrategy(value: unknown): UpdateStrategy | undefined {
  return value === "immediate" || value === "coordinated" || value === "deferred"
    ? value
    : undefined;
}

/**
 * Validate the `externalConnectionFiles` bag entry into a real
 * {@link ExternalAgentFile}, keeping only well-formed `{ path, enabled }` pairs.
 * Returns `undefined` when the field is absent so the DTO omits it (matching the
 * previous pass-through behavior for a missing field).
 */
function toExternalConnectionFiles(value: unknown): ExternalAgentFile[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const files: ExternalAgentFile[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    // Localized narrowing of a validated non-null object to index its fields;
    // each field is then runtime-checked below (not a blanket `as unknown as`).
    const record = entry as Record<string, unknown>;
    if (typeof record.path === "string" && typeof record.enabled === "boolean") {
      files.push({ path: record.path, enabled: record.enabled });
    }
  }
  return files;
}

/**
 * Build a {@link RemoteAgentConfig} from the editor's form settings bag.
 *
 * Required fields fall back to schema defaults (`port` 22, `authMethod`
 * `"password"`, empty strings) so the returned DTO is always well-formed; every
 * optional field is preserved when present and omitted when absent.
 */
export function toRemoteAgentConfig(record: Record<string, unknown>): RemoteAgentConfig {
  const cc: ConnectionConfig = { type: "remote", config: record };
  const config: RemoteAgentConfig = {
    host: readConfigString(cc, "host") ?? "",
    port: readConfigNumber(cc, "port") ?? 22,
    username: readConfigString(cc, "username") ?? "",
    authMethod: toAuthMethod(record.authMethod),
  };

  const password = readConfigString(cc, "password");
  if (password !== undefined) config.password = password;

  const keyPath = readConfigString(cc, "keyPath");
  if (keyPath !== undefined) config.keyPath = keyPath;

  const savePassword = readConfigBoolean(cc, "savePassword");
  if (savePassword !== undefined) config.savePassword = savePassword;

  const agentPath = readConfigString(cc, "agentPath");
  if (agentPath !== undefined) config.agentPath = agentPath;

  const externalConnectionFiles = toExternalConnectionFiles(record.externalConnectionFiles);
  if (externalConnectionFiles !== undefined)
    config.externalConnectionFiles = externalConnectionFiles;

  const allowSelfUpdate = readConfigBoolean(cc, "allowSelfUpdate");
  if (allowSelfUpdate !== undefined) config.allowSelfUpdate = allowSelfUpdate;

  const updateStrategy = toUpdateStrategy(record.updateStrategy);
  if (updateStrategy !== undefined) config.updateStrategy = updateStrategy;

  return config;
}

/**
 * The inverse of {@link toRemoteAgentConfig}: project a {@link RemoteAgentConfig}
 * DTO back into the editor's form settings bag. Optional fields are copied only
 * when present so the bag mirrors the stored config exactly.
 */
export function remoteAgentConfigToRecord(config: RemoteAgentConfig): Record<string, unknown> {
  const record: Record<string, unknown> = {
    host: config.host,
    port: config.port,
    username: config.username,
    authMethod: config.authMethod,
  };
  if (config.password !== undefined) record.password = config.password;
  if (config.keyPath !== undefined) record.keyPath = config.keyPath;
  if (config.savePassword !== undefined) record.savePassword = config.savePassword;
  if (config.agentPath !== undefined) record.agentPath = config.agentPath;
  if (config.externalConnectionFiles !== undefined)
    record.externalConnectionFiles = config.externalConnectionFiles;
  if (config.allowSelfUpdate !== undefined) record.allowSelfUpdate = config.allowSelfUpdate;
  if (config.updateStrategy !== undefined) record.updateStrategy = config.updateStrategy;
  return record;
}
