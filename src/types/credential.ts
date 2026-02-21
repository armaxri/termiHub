/** Credential storage backend mode. */
export type CredentialStorageMode = "keychain" | "master_password" | "none";

/** Runtime status of the credential store. */
export type CredentialStoreStatus = "unlocked" | "locked" | "unavailable";

/** Full status information about the credential store. */
export interface CredentialStoreStatusInfo {
  mode: CredentialStorageMode;
  status: CredentialStoreStatus;
  keychainAvailable: boolean;
}

/** Result of switching to a different credential store backend. */
export interface SwitchCredentialStoreResult {
  migratedCount: number;
  warnings: string[];
}
