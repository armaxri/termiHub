/**
 * Pure utility functions for working with SettingsSchema.
 *
 * These are used by the generic form renderer and the ConnectionEditor
 * to derive defaults, evaluate visibility conditions, and detect
 * password-prompt requirements.
 */

import type { SettingsSchema, SettingsField, Condition } from "@/types/schema";
import type { PasswordPromptInfo } from "@/types/generated/PasswordPromptInfo";
import { isSameHost, isSameNamedHost } from "./sameHost";

// Generated via ts-rs from the Rust `PasswordPromptInfo` in
// `core/src/connection/schema_defaults.rs` (#3088).
export type { PasswordPromptInfo };

/**
 * Build a default settings object from a schema.
 *
 * Iterates all fields in all groups and collects `default` values
 * into a flat `Record<string, unknown>`. Fields without a default
 * are omitted (the form renderer treats them as empty/unset).
 */
export function buildDefaults(schema: SettingsSchema): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const group of schema.groups) {
    collectFieldDefaults(group.fields, result);
  }
  return result;
}

function collectFieldDefaults(fields: SettingsField[], out: Record<string, unknown>): void {
  for (const field of fields) {
    if (field.default !== undefined) {
      out[field.key] = field.default;
    }
    // For objectList fields, provide an empty array default when none is set
    if (field.fieldType.type === "objectList" && out[field.key] === undefined) {
      out[field.key] = [];
    }
    // For keyValueList fields, provide an empty array default when none is set
    if (field.fieldType.type === "keyValueList" && out[field.key] === undefined) {
      out[field.key] = [];
    }
  }
}

/**
 * Overlay the current settings on the schema defaults, so a key the saved
 * config omits reads as its schema default — the same effective value the field
 * itself renders (e.g. a Boolean toggle shows `value ?? default`).
 *
 * Used for `visibleWhen` evaluation: without it a field gated on a default-on
 * toggle (e.g. SSH `onReconnectCommand` on `autoReconnect`, PARITY-008) would
 * stay hidden for a connection saved before that toggle existed, even though
 * the toggle is shown as on. `undefined` values do not mask a default.
 */
export function withSchemaDefaults(
  schema: SettingsSchema,
  settings: Record<string, unknown> | undefined
): Record<string, unknown> {
  const result = buildDefaults(schema);
  for (const [key, value] of Object.entries(settings ?? {})) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/**
 * Evaluate whether a field should be visible given the current settings values.
 *
 * Returns `true` if the field has no `visibleWhen` condition, or if the
 * condition is satisfied.
 */
export function isFieldVisible(field: SettingsField, settings: Record<string, unknown>): boolean {
  if (!field.visibleWhen) return true;
  return evaluateCondition(field.visibleWhen, settings);
}

/**
 * Evaluate one visibility condition (including its `allOf` / `anyOf`
 * sub-conditions) against the settings. Mirrors `evaluate_condition` in
 * `core/src/connection/schema_defaults.rs`.
 *
 * - Basic rule: `settings[field]` equals `equals` (JSON comparison).
 * - `sameHostAs`: `equals` is compared with whether `settings[field]` names the
 *   same host as `settings[sameHostAs]` ({@link hostsCompareSame}).
 * - `sameNameAs`: the same comparison with both hosts seen from this computer
 *   (`isSameNamedHost`, #4194).
 * - `allOf`: every sub-condition must hold too.
 * - `anyOf`: when non-empty, at least one sub-condition must hold.
 */
export function evaluateCondition(
  condition: Condition,
  settings: Record<string, unknown>
): boolean {
  let primary: boolean;
  if (condition.sameHostAs !== undefined) {
    const same = hostsCompareSame(
      settings[condition.field],
      settings[condition.sameHostAs],
      isSameHost
    );
    primary = condition.equals === same;
  } else if (condition.sameNameAs !== undefined) {
    const same = hostsCompareSame(
      settings[condition.field],
      settings[condition.sameNameAs],
      isSameNamedHost
    );
    primary = condition.equals === same;
  } else {
    // Use JSON comparison for robust value matching (handles strings, numbers, booleans)
    primary = JSON.stringify(settings[condition.field]) === JSON.stringify(condition.equals);
  }
  const allOf = condition.allOf ?? [];
  const anyOf = condition.anyOf ?? [];
  return (
    primary &&
    allOf.every((c) => evaluateCondition(c, settings)) &&
    (anyOf.length === 0 || anyOf.some((c) => evaluateCondition(c, settings)))
  );
}

/**
 * The host comparison behind `Condition.sameHostAs` and `Condition.sameNameAs`:
 * whether `target` names the same host as `fileHost` by `same` (`isSameHost` or
 * `isSameNamedHost`). When either side is unset, not a string, or blank the
 * hosts cannot be shown to differ, so they compare as the same host.
 */
function hostsCompareSame(
  target: unknown,
  fileHost: unknown,
  same: (target: string, fileHost: string) => boolean
): boolean {
  const text = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  const t = text(target);
  const f = text(fileHost);
  if (t === null || f === null) return true;
  return same(t, f);
}

/**
 * Substitute `{{fieldKey}}` placeholders in a notice message with the current
 * setting values (#4198). Strings, numbers and booleans render as text; an
 * unset or structured value renders as empty. A key may be dotted, naming a
 * value the form derives (e.g. `fileTransferVia.host`, #4194).
 */
export function interpolateSettings(template: string, settings: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_, key: string) => {
    const value = settings[key];
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return "";
  });
}

/**
 * Check whether a connection needs a password prompt at connect time.
 *
 * Scans the schema for a visible Password field whose current value is
 * empty/undefined. Returns prompt info if found, or `null` if no
 * password is needed.
 */
export function findPasswordPromptInfo(
  schema: SettingsSchema,
  settings: Record<string, unknown>
): PasswordPromptInfo | null {
  for (const group of schema.groups) {
    for (const field of group.fields) {
      if (field.fieldType.type !== "password") continue;
      if (!isFieldVisible(field, settings)) continue;

      // If the password already has a value, no prompt needed
      const value = settings[field.key];
      if (value && typeof value === "string" && value.length > 0) continue;

      // Find host and username fields in the schema for the prompt dialog
      const hostKey = findFieldKey(schema, "host") ?? "host";
      const usernameKey = findFieldKey(schema, "username") ?? "username";

      return {
        hostKey,
        usernameKey,
        passwordKey: field.key,
      };
    }
  }
  return null;
}

/**
 * Check whether an SSH **key-auth** connection needs a passphrase prompt at
 * connect time.
 *
 * `findPasswordPromptInfo` only matches a *visible* password field, but the
 * password field is hidden for key auth (`visible_when: authMethod == "password"`),
 * so it never prompts for a key passphrase. This sibling check covers key auth.
 *
 * Returns prompt info when `authMethod === "key"` and the key is actually
 * **encrypted** (`keyEncrypted`), regardless of the `savePassword` flag (#885):
 * a passphrase-protected key cannot connect without a passphrase, and an
 * unencrypted key never needs one. The caller determines `keyEncrypted` by
 * inspecting the key file (`isSshKeyEncrypted`); whether the entered passphrase
 * is *stored* still follows the prompt's Save box.
 *
 * The resolved passphrase is passed to the backend via the same `password`
 * config field the SSH backend reads to unlock the key.
 */
export function findKeyPassphrasePromptInfo(
  schema: SettingsSchema,
  settings: Record<string, unknown>,
  keyEncrypted: boolean
): PasswordPromptInfo | null {
  if (settings.authMethod !== "key") return null;
  if (!keyEncrypted) return null;

  return {
    hostKey: findFieldKey(schema, "host") ?? "host",
    usernameKey: findFieldKey(schema, "username") ?? "username",
    passwordKey: findFieldKey(schema, "password") ?? "password",
  };
}

/**
 * Find a field key in the schema by key name.
 */
function findFieldKey(schema: SettingsSchema, key: string): string | null {
  for (const group of schema.groups) {
    for (const field of group.fields) {
      if (field.key === key) return field.key;
    }
  }
  return null;
}

/**
 * Filter out credential-related fields (`password`, `savePassword`) from a
 * schema when no credential store is configured.
 *
 * When the credential store mode is `"none"`, passwords are always prompted
 * at connect time — pre-filling or saving them in the editor is meaningless.
 * Those fields are therefore removed from the rendered schema so they don't
 * appear in the connection editor.
 *
 * Returns a shallow-cloned schema with those fields removed when mode is
 * `"none"`. The original schema is never mutated. All other modes are
 * returned unchanged.
 */
export function filterCredentialFields(
  schema: SettingsSchema,
  credentialMode: string | undefined
): SettingsSchema {
  if (credentialMode !== "none") return schema;
  return {
    groups: schema.groups.map((group) => ({
      ...group,
      fields: group.fields.filter((f) => f.key !== "password" && f.key !== "savePassword"),
    })),
  };
}

/**
 * Filter the `runtime` select options in a Docker connection schema based on
 * which container runtimes are actually available on the system.
 *
 * Rules:
 * - "auto" is kept only when both Docker and Podman are available
 * - "docker" is kept only when Docker is available
 * - "podman" is kept only when Podman is available
 * - If neither is available, all options are kept (fallback — the backend
 *   will produce a proper error when the user tries to connect)
 *
 * Returns a shallow-cloned schema with filtered options. The original schema
 * is never mutated.
 */
export function filterRuntimeOptions(
  schema: SettingsSchema,
  dockerAvailable: boolean,
  podmanAvailable: boolean
): SettingsSchema {
  // Fallback: if neither is available, don't filter anything
  if (!dockerAvailable && !podmanAvailable) return schema;

  return {
    groups: schema.groups.map((group) => ({
      ...group,
      fields: group.fields.map((field) => {
        if (field.key !== "runtime" || field.fieldType.type !== "select") return field;

        const filtered = field.fieldType.options.filter((opt) => {
          if (opt.value === "auto") return dockerAvailable && podmanAvailable;
          if (opt.value === "docker") return dockerAvailable;
          if (opt.value === "podman") return podmanAvailable;
          return true;
        });

        return {
          ...field,
          fieldType: { ...field.fieldType, options: filtered },
        };
      }),
    })),
  };
}
