import { currentSettingsView, mirrorSettingsIntent } from "@/store/settingsBridge";
import type { ShellIntegrationStatus } from "@/types/connection";
import type { ToastPromiseMessages } from "@/components/ui";
import { defaultShellIntegrationSettings } from "./shellIntegrationEntries";

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

/** Toast messages for the register (install / reinstall) lifecycle. */
export const INSTALL_TOAST: ToastPromiseMessages<unknown> = {
  loading: "Registering shell integration…",
  success: "Shell integration registered",
  error: (e) => `Registration failed: ${String(e)}`,
};

/** Toast messages for the unregister (uninstall) lifecycle. */
export const UNINSTALL_TOAST: ToastPromiseMessages<unknown> = {
  loading: "Removing shell integration…",
  success: "Shell integration removed",
  error: (e) => `Removal failed: ${String(e)}`,
};
