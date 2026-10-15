/**
 * Which stored secrets the connection editor shows as "saved" (#4431).
 *
 * Since #4289 a saved connection's schema secrets other than `password` — a
 * VNC `sshPassword`, a plugin's password field, an inline jump-host hop's
 * password — live in the credential store and reach the editor empty. The
 * editor learns only their **names** (settings keys, or hop identities) and
 * passes them down with the user's pending clears; an empty field still means
 * "keep", and a stored secret is removed only by an explicit Clear, on save.
 */
import type { StoredSecretState } from "./DynamicField";

/** The stored secret names of one kind and the user's pending clears. */
export interface StoredSecretsControl {
  /** Names (settings keys or hop identities) of the stored secrets. */
  stored: readonly string[];
  /** Names marked for removal on save. */
  cleared: readonly string[];
  onClear: (name: string) => void;
  onUndo: (name: string) => void;
}

/**
 * The {@link StoredSecretState} of `name` for a password field holding
 * `value`, or `undefined` when nothing is stored under it or the user typed a
 * replacement.
 */
export function storedSecretState(
  control: StoredSecretsControl | undefined,
  name: string | null,
  value: unknown
): StoredSecretState | undefined {
  if (!control || name === null || !control.stored.includes(name)) return undefined;
  if (typeof value === "string" && value.length > 0) return undefined;
  return {
    cleared: control.cleared.includes(name),
    onClear: () => control.onClear(name),
    onUndo: () => control.onUndo(name),
  };
}
