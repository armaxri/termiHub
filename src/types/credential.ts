// Full status information about the credential store, generated from the Rust
// `CredentialStoreStatusInfo` via ts-rs (audit DUP-030, ts-rs rollout #3088).
import type { CredentialStoreStatusInfo } from "./generated/CredentialStoreStatusInfo";

export type { CredentialStoreStatusInfo };

/** Credential storage backend mode. */
export type CredentialStorageMode = CredentialStoreStatusInfo["mode"];

/**
 * Structured outcome of the credential migration performed by a store switch,
 * computed by the backend from real per-credential results (#2839):
 * - `success` — every credential was migrated (or there was nothing to migrate).
 * - `partial` — some credentials were migrated, some failed.
 * - `failed` — none of the credentials could be migrated.
 *
 * A `failed` switch is rolled back (#3323): the previous store stays active and
 * nothing changes. For a switch to `none` the counts describe credentials
 * *removed* from the previous store instead of migrated.
 */
export type CredentialMigrationStatus = "success" | "partial" | "failed";

/** Result of switching to a different credential store backend. */
export interface SwitchCredentialStoreResult {
  status: CredentialMigrationStatus;
  migratedCount: number;
  /** Credentials that could not be migrated/removed (still in the previous store). */
  failedCount: number;
  warnings: string[];
  /** Switch to `none` only: credentials removed from the previous store. */
  removedCount: number;
  /** Switch to `none` only: entries (`connection:type`) that could not be removed. */
  remaining: string[];
  /** The switch failed completely and was rolled back — nothing changed. */
  rolledBack: boolean;
}

// Credential-vault export/import DTOs (PROD-063), generated from their Rust
// source of truth (`credential::vault`) via ts-rs.
export type { ConflictStrategy as VaultConflictStrategy } from "./generated/ConflictStrategy";
export type { VaultConflict } from "./generated/VaultConflict";
export type { VaultError } from "./generated/VaultError";
export type { VaultImportPreview } from "./generated/VaultImportPreview";
export type { VaultImportResult } from "./generated/VaultImportResult";

// OS user verification + biometric unlock DTOs (#3433, PROD-064), generated
// from `credential::os_auth` / `credential::biometric_unlock` via ts-rs.
export type { OsAuthInfo } from "./generated/OsAuthInfo";
export type { BiometricUnlockError } from "./generated/BiometricUnlockError";
export type { BiometricUnlockStatus } from "./generated/BiometricUnlockStatus";
