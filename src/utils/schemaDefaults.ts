/**
 * Pure utility functions for working with SettingsSchema.
 *
 * These are used by the generic form renderer and the ConnectionEditor
 * to derive defaults, evaluate visibility conditions, and detect
 * password-prompt requirements.
 */

import type { SettingsSchema, SettingsField, Condition } from "@/types/schema";

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
 * Evaluate whether a field should be visible given the current settings values.
 *
 * Returns `true` if the field has no `visibleWhen` condition, or if the
 * condition is satisfied.
 */
export function isFieldVisible(
  field: SettingsField,
  settings: Record<string, unknown>
): boolean {
  if (!field.visibleWhen) return true;
  return evaluateCondition(field.visibleWhen, settings);
}

function evaluateCondition(condition: Condition, settings: Record<string, unknown>): boolean {
  const actual = settings[condition.field];
  // Use JSON comparison for robust value matching (handles strings, numbers, booleans)
  return JSON.stringify(actual) === JSON.stringify(condition.equals);
}

/**
 * Information about a password field that should be prompted at connect time.
 */
export interface PasswordPromptInfo {
  /** The settings key containing the host/identifier for the prompt dialog. */
  hostKey: string;
  /** The settings key containing the username for the prompt dialog. */
  usernameKey: string;
  /** The settings key where the password value lives. */
  passwordKey: string;
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
