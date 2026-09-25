/** Credential storage backend mode. */
export type CredentialStorageMode = "master_password" | "os_keychain" | "none";

/** Runtime status of the credential store. */
export type CredentialStoreStatus = "unlocked" | "locked" | "unavailable";

/** Full status information about the credential store. */
export interface CredentialStoreStatusInfo {
  mode: CredentialStorageMode;
  status: CredentialStoreStatus;
}

/**
 * Structured outcome of the credential migration performed by a store switch,
 * computed by the backend from real per-credential results (#2839):
 * - `success` — every credential was migrated (or there was nothing to migrate).
 * - `partial` — some credentials were migrated, some failed.
 * - `failed` — none of the credentials could be migrated.
 *
 * In every case the store switch itself has happened; failed credentials stay
 * in the previous store, which is left intact.
 */
export type CredentialMigrationStatus = "success" | "partial" | "failed";

/** Result of switching to a different credential store backend. */
export interface SwitchCredentialStoreResult {
  status: CredentialMigrationStatus;
  migratedCount: number;
  /** Credentials that could not be migrated (still in the previous store). */
  failedCount: number;
  warnings: string[];
}
