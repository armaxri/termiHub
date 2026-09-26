// Unified backup and restore DTOs (PROD-068), generated from their Rust source
// of truth (`src-tauri/src/backup`) via ts-rs. Errors reuse the credential
// vault's `VaultError` (`kind` + `message`), see `isVaultError` in api.ts.
export type { BackupCredentialsPreview } from "./generated/BackupCredentialsPreview";
export type { BackupExportOptions } from "./generated/BackupExportOptions";
export type { BackupExportResult } from "./generated/BackupExportResult";
export type { BackupHeader } from "./generated/BackupHeader";
export type { BackupRestorePreview } from "./generated/BackupRestorePreview";
export type { BackupRestoreRequest } from "./generated/BackupRestoreRequest";
export type { BackupRestoreResult } from "./generated/BackupRestoreResult";
export type { BackupSectionInfo } from "./generated/BackupSectionInfo";
export type { BackupSectionPreview } from "./generated/BackupSectionPreview";
export type { RestoreMode } from "./generated/RestoreMode";
export type { SectionRestoreChoice } from "./generated/SectionRestoreChoice";
export type { SectionRestoreOutcome } from "./generated/SectionRestoreOutcome";
export type { SectionStatus } from "./generated/SectionStatus";
