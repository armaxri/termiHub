/**
 * Keep typed secrets out of a form draft that leaves its editor (#4500).
 *
 * "Move tabs" on window close carries a dirty form editor's unsaved values to
 * another window through the backend's in-memory hand-off queue. A password the
 * user typed into the form lives only in that editor today; it must not be
 * copied anywhere else, so the draft carries every secret field empty and the
 * close dialog tells the user which ones to type again in the other window.
 *
 * A value counts as a secret when the connection type's schema marks its field
 * as a password field, or when its key names a secret by the shared word list
 * the log redactors use ({@link isSecretKeyName}: `password`, `sshPassword`,
 * `keyPassphrase`, `apiToken`, ...). Nested objects and arrays (a jump-host
 * chain's inline hop passwords, a workspace tab's inline connection config) are
 * cleared too. Only string values are cleared, so a flag such as
 * `savePassword: true` survives.
 */
import type { SettingsSchema } from "@/types/schema";
import { isSecretKeyName } from "@/utils/redactLogText";

/** The outcome of {@link clearDraftSecrets}. */
export interface ClearedDraft<T> {
  /** A copy of the draft with every secret string set to `""`. */
  values: T;
  /** User-facing labels of the secrets that held a value, de-duplicated, in order. */
  cleared: string[];
}

/** Turn a key such as `sshPassword` into a readable label ("ssh password"). */
function keyLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The password-type fields of `schema`, keyed by settings key, with their labels. */
function schemaSecretLabels(schema: SettingsSchema | undefined): Map<string, string> {
  const labels = new Map<string, string>();
  for (const group of schema?.groups ?? []) {
    for (const field of group.fields) {
      if (field.fieldType.type === "password") labels.set(field.key, field.label);
    }
  }
  return labels;
}

/**
 * A copy of `values` with every secret string cleared, plus the labels of the
 * secrets that held a value. `schema` (the connection type's settings schema)
 * names extra password fields and gives top-level secrets their form label.
 */
export function clearDraftSecrets<T>(values: T, schema?: SettingsSchema): ClearedDraft<T> {
  const schemaLabels = schemaSecretLabels(schema);
  const cleared: string[] = [];
  const note = (label: string) => {
    if (!cleared.includes(label)) cleared.push(label);
  };

  const walk = (value: unknown, topLevel: boolean, hopContext: boolean): unknown => {
    if (Array.isArray(value)) return value.map((item) => walk(item, false, hopContext));
    if (typeof value !== "object" || value === null) return value;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const schemaLabel = topLevel ? schemaLabels.get(key) : undefined;
      if (typeof entry === "string" && (schemaLabel !== undefined || isSecretKeyName(key))) {
        out[key] = "";
        if (entry.length > 0) {
          note(
            hopContext ? `Jump host ${keyLabel(key).toLowerCase()}` : (schemaLabel ?? keyLabel(key))
          );
        }
        continue;
      }
      const isHopList = key === "proxyJump" || key === "jumpHosts";
      out[key] = walk(entry, false, hopContext || isHopList);
    }
    return out;
  };

  return { values: walk(values, true, false) as T, cleared };
}
