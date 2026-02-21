/**
 * Shared credential resolution utility.
 *
 * Resolves credentials from the credential store for SSH connections
 * before falling back to prompting the user.
 */

import { resolveCredential } from "@/services/api";

/** Result of resolving a credential from the store. */
export interface CredentialResolution {
  /** The resolved password/passphrase, or null if not found. */
  password: string | null;
  /** Whether the credential came from the store (vs. not found). */
  usedStoredCredential: boolean;
  /** Which credential type was looked up. */
  credentialType: "password" | "key_passphrase";
}

/**
 * Attempt to resolve a credential from the credential store.
 *
 * Resolution logic:
 * - `authMethod === "password"` → look up `"password"` from store
 * - `authMethod === "key"` and `savePassword` is true → look up `"key_passphrase"`
 * - `authMethod === "agent"` or no `savePassword` → skip, return null
 *
 * Errors from the store are caught and treated as "not found".
 */
export async function resolveConnectionCredential(
  connectionId: string,
  authMethod: string,
  savePassword?: boolean
): Promise<CredentialResolution> {
  if (authMethod === "password") {
    try {
      const password = await resolveCredential(connectionId, "password");
      return {
        password,
        usedStoredCredential: password !== null,
        credentialType: "password",
      };
    } catch {
      return { password: null, usedStoredCredential: false, credentialType: "password" };
    }
  }

  if (authMethod === "key" && savePassword) {
    try {
      const password = await resolveCredential(connectionId, "key_passphrase");
      return {
        password,
        usedStoredCredential: password !== null,
        credentialType: "key_passphrase",
      };
    } catch {
      return { password: null, usedStoredCredential: false, credentialType: "key_passphrase" };
    }
  }

  // agent auth or key without savePassword — no credential to resolve
  return { password: null, usedStoredCredential: false, credentialType: "password" };
}
