import type { OsAuthInfo } from "@/types/credential";

/** OS verification available (e.g. a Mac with Touch ID). */
export const OS_AUTH_AVAILABLE: OsAuthInfo = {
  exportReauth: { available: true, methodLabel: "Touch ID or your Mac password", reason: null },
  biometricUnlock: { supported: true, enabled: false, methodLabel: "Touch ID", reason: null },
};

/** OS verification unavailable (e.g. Linux). */
export const OS_AUTH_UNAVAILABLE: OsAuthInfo = {
  exportReauth: {
    available: false,
    methodLabel: "system authentication",
    reason: "No supported system authentication.",
  },
  biometricUnlock: {
    supported: false,
    enabled: false,
    methodLabel: "system authentication",
    reason: "No supported system authentication.",
  },
};

/** Biometric unlock turned on. */
export const OS_AUTH_BIOMETRIC_ENABLED: OsAuthInfo = {
  ...OS_AUTH_AVAILABLE,
  biometricUnlock: { ...OS_AUTH_AVAILABLE.biometricUnlock, enabled: true },
};
