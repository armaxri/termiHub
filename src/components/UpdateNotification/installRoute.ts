import type { ReleasePageReason } from "@/types/generated/ReleasePageReason";
import type { UpdateInfo } from "@/types/connection";

/** Whether this update installs in place through the signed updater (#5758). */
export function isInAppUpdate(info: UpdateInfo | null | undefined): boolean {
  return info?.available === true && info.installMethod === "inApp";
}

/**
 * Why an update is installed from the downloads page, for the few reasons the
 * user can act on or should know about (#5758). `null` for the default cases
 * (no updater key yet, develop builds), which simply keep the downloads page.
 */
export function releasePageHint(reason: ReleasePageReason | undefined): string | null {
  switch (reason) {
    case "packageManager":
      return "Installed from a .deb or .rpm package: update it from the downloads page or your package manager.";
    case "portable":
      return "Portable copy: replace it with the new download.";
    case "isolatedInstance":
      return "This instance runs on an isolated profile, so it is not updated in place.";
    case "unsupportedInstall":
      return "This install type has no in-app update: use the downloads page.";
    default:
      return null;
  }
}

/** "Downloading… 42%" (or without a percentage when the size is unknown). */
export function downloadLabel(downloaded: number, total: number | null): string {
  if (!total || total <= 0) return "Downloading…";
  const pct = Math.min(100, Math.floor((downloaded / total) * 100));
  return `Downloading… ${pct}%`;
}
