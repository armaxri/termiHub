/**
 * Shared credential resolution utility.
 *
 * Resolves credentials from the credential store for SSH connections
 * before falling back to prompting the user.
 */

import { resolveCredential } from "@/services/api";
import { resolveNamedCredential } from "@/services/namedCredentials";

/** Result of resolving a credential from the store. */
export interface CredentialResolution {
  /** The resolved password/passphrase, or null if not found. */
  password: string | null;
  /** Whether the credential came from the store (vs. not found). */
  usedStoredCredential: boolean;
  /** Which credential type was looked up. */
  credentialType: "password" | "key_passphrase";
  /**
   * Set when the connection references a shared named credential (#3557) and
   * the lookup went to it. Callers must then never delete it on an auth
   * failure (other connections share it) nor store a prompted secret as a
   * per-connection one (it would never be read).
   */
  namedCredentialId?: string;
}

/** Read `raw` as a usable secret: an empty string counts as not found. */
function toResolution(
  raw: string | null,
  credentialType: CredentialResolution["credentialType"],
  namedCredentialId: string | undefined
): CredentialResolution {
  const password = raw === "" ? null : raw;
  const resolution: CredentialResolution = {
    password,
    usedStoredCredential: password !== null,
    credentialType,
  };
  if (namedCredentialId) resolution.namedCredentialId = namedCredentialId;
  return resolution;
}

/** Look up one secret; store errors are treated as "not found". */
async function lookup(
  connectionId: string,
  credentialType: CredentialResolution["credentialType"],
  credentialRef: string | undefined
): Promise<CredentialResolution> {
  try {
    const raw = credentialRef
      ? await resolveNamedCredential(credentialRef, credentialType)
      : await resolveCredential(connectionId, credentialType);
    return toResolution(raw, credentialType, credentialRef);
  } catch {
    return toResolution(null, credentialType, credentialRef);
  }
}

/**
 * Attempt to resolve a credential from the credential store.
 *
 * Resolution logic:
 * - `credentialRef` set (a shared named credential, #3557) → look up **only**
 *   that credential — for password auth, and for key auth regardless of
 *   `savePassword`. The per-connection secret is never consulted, so a rotated
 *   shared secret cannot be shadowed by a stale per-connection copy.
 * - `authMethod === "password"` → look up `"password"` from store
 * - `authMethod === "key"` and `savePassword` is true → look up `"key_passphrase"`
 * - `authMethod === "agent"` or no `savePassword` → skip, return null
 *
 * Errors from the store are caught and treated as "not found".
 */
export async function resolveConnectionCredential(
  connectionId: string,
  authMethod: string,
  savePassword?: boolean,
  credentialRef?: string
): Promise<CredentialResolution> {
  const ref = credentialRef?.trim() || undefined;
  if (authMethod === "password") {
    return lookup(connectionId, "password", ref);
  }

  if (authMethod === "key" && (savePassword || ref)) {
    return lookup(connectionId, "key_passphrase", ref);
  }

  // agent auth or key without savePassword — no credential to resolve
  return { password: null, usedStoredCredential: false, credentialType: "password" };
}
