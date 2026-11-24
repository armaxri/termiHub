import { currentSettingsView, mirrorSettingsIntent } from "@/store/settingsBridge";
import type { ShellIntegrationStatus } from "@/types/connection";
import type { ToastPromiseMessages } from "@/components/ui";
import { defaultShellIntegrationSettings } from "./shellIntegrationEntries";
import { errorMessage } from "@/utils/errorMessage";
import { fileManagerPlace } from "@/utils/platform";
import { tf } from "@/i18n/catalog";

/**
 * Reflect the registration facts from a refreshed status into the authoritative
 * `settings` region (#2404). Unlike editing the shell-integration settings (which
 * persists via `updateShellIntegration`), the install/uninstall commands have
 * already persisted server-side and fold the outcome into the region server-side
 * (#2407); this optimistically patches the returned `registered` /
 * `registeredExePath` facts so the UI reflects them instantly without waiting for
 * the fold. There is no `appStore` settings slice to write any more.
 */
export function syncRegistrationFacts(status: ShellIntegrationStatus): void {
  const current = currentSettingsView().shellIntegration ?? defaultShellIntegrationSettings();
  const nextSi = {
    ...current,
    registered: status.registered,
    registeredExePath: status.registeredExePath,
  };
  mirrorSettingsIntent("settings.patch", { patch: { shellIntegration: nextSi } });
}

/**
 * Toast messages for adding (or updating) the "Open in termiHub" menu entry,
 * worded with the platform's file manager (#5845).
 */
export function installToast(place: string = fileManagerPlace()): ToastPromiseMessages<unknown> {
  return {
    loading: tf("fileManagerIntegration.toast.adding", { place }),
    success: tf("fileManagerIntegration.toast.added", { place }),
    error: (e) => tf("fileManagerIntegration.toast.addFailed", { place, error: errorMessage(e) }),
  };
}

/** Toast messages for removing the "Open in termiHub" menu entry (#5845). */
export function uninstallToast(place: string = fileManagerPlace()): ToastPromiseMessages<unknown> {
  return {
    loading: tf("fileManagerIntegration.toast.removing", { place }),
    success: tf("fileManagerIntegration.toast.removed", { place }),
    error: (e) =>
      tf("fileManagerIntegration.toast.removeFailed", { place, error: errorMessage(e) }),
  };
}
