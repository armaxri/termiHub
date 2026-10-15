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

/** Words a key label spells in capitals. */
const ACRONYMS: ReadonlySet<string> = new Set(["ssh", "api", "otp", "totp", "pin", "id", "vnc"]);

/** Turn a key such as `sshPassword` into a readable label ("SSH password"). */
function keyLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((word) => (ACRONYMS.has(word) ? word.toUpperCase() : word))
    .join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A hop secret's label after "Jump host": the key label, lower-case but for acronyms. */
function hopLabel(key: string): string {
  const label = keyLabel(key);
  const [first = "", ...rest] = label.split(" ");
  return [ACRONYMS.has(first.toLowerCase()) ? first : first.toLowerCase(), ...rest].join(" ");
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
          note(hopContext ? `Jump host ${hopLabel(key)}` : (schemaLabel ?? keyLabel(key)));
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

/**
 * Labels of the secrets in `values` that differ from `baseline`: the secrets
 * the user typed (or cleared) and has not saved yet. A form that holds a whole
 * persisted document, such as the Settings panel, carries saved secrets in its
 * draft too; only the unsaved ones are lost by a move, so only they are named.
 */
export function changedSecretLabels(values: unknown, baseline: unknown): string[] {
  const labels: string[] = [];
  const walk = (value: unknown, base: unknown) => {
    if (typeof value !== "object" || value === null) return;
    const baseObj = typeof base === "object" && base !== null ? base : {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const baseEntry = (baseObj as Record<string, unknown>)[key];
      if (typeof entry === "string" && isSecretKeyName(key)) {
        const label = keyLabel(key);
        if (entry !== (baseEntry ?? "") && !labels.includes(label)) labels.push(label);
        continue;
      }
      walk(entry, baseEntry);
    }
  };
  walk(values, baseline);
  return labels;
}

/**
 * A copy of a carried draft whose secret strings are taken from `base` (the
 * receiving window's saved document) instead of staying empty. Used where the
 * restored draft is saved straight away (the Settings panel auto-saves), so a
 * secret cleared for the move never overwrites the saved one with `""`: the
 * unsaved secret is dropped and the saved value stays (or the key stays absent
 * when nothing is saved for it).
 */
export function restoreDraftSecrets<T>(values: T, base: unknown): T {
  const walk = (value: unknown, baseValue: unknown): unknown => {
    const baseObj =
      typeof baseValue === "object" && baseValue !== null
        ? (baseValue as Record<string, unknown>)
        : {};
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        walk(item, Array.isArray(baseValue) ? baseValue[index] : undefined)
      );
    }
    if (typeof value !== "object" || value === null) return value;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (typeof entry === "string" && isSecretKeyName(key)) {
        // No saved value: leave the key out, as the saved document does.
        const saved = baseObj[key];
        if (typeof saved === "string") out[key] = saved;
        continue;
      }
      out[key] = walk(entry, baseObj[key]);
    }
    return out;
  };
  return walk(values, base) as T;
}
