import type { OsAuthInfo } from "@/types/credential";

/**
 * Why export is refused in OS-keychain mode when the OS cannot verify the
 * user. Mirrors the backend `KEYCHAIN_EXPORT_UNAVAILABLE_MESSAGE`; the backend
 * enforces the gate independently (#3433). Backup & restore uses it for the
 * credentials it backs up.
 */
export const KEYCHAIN_EXPORT_UNAVAILABLE_REASON =
  "Exporting from the OS Keychain requires system authentication (Touch ID / Windows Hello / polkit), which is not available on this computer.";

/** Shown while the OS-verification capability is still being read. */
export const KEYCHAIN_EXPORT_CHECKING_REASON = "Checking system authentication…";

/**
 * Why an OS-keychain export is unavailable, or null when the OS can verify
 * the user. `null` info (not loaded / query failed) fails closed.
 */
export function keychainExportReason(info: OsAuthInfo | null): string | null {
  if (info === null) return KEYCHAIN_EXPORT_CHECKING_REASON;
  if (info.exportReauth.available) return null;
  return [KEYCHAIN_EXPORT_UNAVAILABLE_REASON, info.exportReauth.reason].filter(Boolean).join(" ");
}
