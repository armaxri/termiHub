/**
 * Tauri commands for shared named credentials (#3557).
 *
 * A named credential is a password or key passphrase with a stable id that
 * several connections / remote agents reference via `credentialRef` instead of
 * carrying their own secret. Secrets only travel *into* the backend (create /
 * rotate); the single read path, {@link resolveNamedCredential}, serves the
 * connect flow exactly like the per-connection `resolveCredential`.
 */

import { invoke } from "@tauri-apps/api/core";
import type { NamedCredential } from "@/types/generated/NamedCredential";
import type { NamedCredentialEntry } from "@/types/generated/NamedCredentialEntry";
import type { NamedCredentialError } from "@/types/generated/NamedCredentialError";
import type { NamedCredentialKind } from "@/types/generated/NamedCredentialKind";

/** The connection-settings key that references a named credential. */
export const CREDENTIAL_REF_KEY = "credentialRef";

/** Window event fired after any named-credential change, so pickers refresh. */
export const NAMED_CREDENTIALS_CHANGED_EVENT = "termihub:named-credentials-changed";

const NAMED_CREDENTIAL_ERROR_KINDS: ReadonlySet<string> = new Set<NamedCredentialError["kind"]>([
  "storeUnavailable",
  "storeLocked",
  "invalid",
  "notFound",
  "inUse",
  "other",
]);

/** Type guard: whether a caught rejection is a structured {@link NamedCredentialError}. */
export function isNamedCredentialError(err: unknown): err is NamedCredentialError {
  if (typeof err !== "object" || err === null) return false;
  const kind = (err as { kind?: unknown }).kind;
  return typeof kind === "string" && NAMED_CREDENTIAL_ERROR_KINDS.has(kind);
}

function notifyChanged(): void {
  window.dispatchEvent(new Event(NAMED_CREDENTIALS_CHANGED_EVENT));
}

/** List every named credential with the connections / agents that use it. */
export async function listNamedCredentials(): Promise<NamedCredentialEntry[]> {
  return await invoke<NamedCredentialEntry[]>("list_named_credentials");
}

/** Create a named credential holding `secret`. */
export async function createNamedCredential(
  name: string,
  kind: NamedCredentialKind,
  secret: string
): Promise<NamedCredential> {
  const created = await invoke<NamedCredential>("create_named_credential", {
    name,
    kind,
    secret,
  });
  notifyChanged();
  return created;
}

/** Rename a named credential (references are by id and unaffected). */
export async function renameNamedCredential(id: string, name: string): Promise<NamedCredential> {
  const renamed = await invoke<NamedCredential>("rename_named_credential", { id, name });
  notifyChanged();
  return renamed;
}

/** Replace a named credential's secret for every connection that uses it. */
export async function rotateNamedCredential(id: string, secret: string): Promise<NamedCredential> {
  const rotated = await invoke<NamedCredential>("rotate_named_credential", { id, secret });
  notifyChanged();
  return rotated;
}

/**
 * Delete a named credential. Rejects with an `inUse` {@link NamedCredentialError}
 * listing the referencing connections while any still use it.
 */
export async function deleteNamedCredential(id: string): Promise<void> {
  await invoke("delete_named_credential", { id });
  notifyChanged();
}

/**
 * Resolve a named credential's secret for a connect. `null` when it does not
 * exist, holds the other kind of secret, or the store is locked/unavailable.
 */
export async function resolveNamedCredential(
  id: string,
  credentialType: "password" | "key_passphrase"
): Promise<string | null> {
  return await invoke<string | null>("resolve_named_credential", { id, credentialType });
}
