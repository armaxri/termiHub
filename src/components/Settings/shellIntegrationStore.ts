import { useAppStore } from "@/store/appStore";
import type { ShellIntegrationStatus } from "@/types/connection";
import type { ToastPromiseMessages } from "@/components/ui";
import { defaultShellIntegrationSettings } from "./shellIntegrationEntries";

/**
 * Merge the registration facts from a refreshed status back into the store,
 * keeping `settings` and `savedSettings` in lockstep. Unlike editing the
 * shell-integration settings (which persists via `updateShellIntegration`), the
 * install/uninstall commands have already persisted server-side — this only
 * reflects the returned `registered` / `registeredExePath` facts into the store.
 */
export function syncRegistrationFacts(status: ShellIntegrationStatus): void {
  useAppStore.setState((s) => {
    const current = s.settings.shellIntegration ?? defaultShellIntegrationSettings();
    const nextSi = {
      ...current,
      registered: status.registered,
      registeredExePath: status.registeredExePath,
    };
    const next = { ...s.settings, shellIntegration: nextSi };
    return { settings: next, savedSettings: next };
  });
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
