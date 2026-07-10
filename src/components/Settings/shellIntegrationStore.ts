import { useAppStore } from "@/store/appStore";
import type { ShellIntegrationSettings, ShellIntegrationStatus } from "@/types/connection";
import type { ToastPromiseMessages } from "@/components/ui";
import { defaultShellIntegrationSettings } from "./shellIntegrationEntries";

/** Read the current shell-integration settings from the store, with a default fallback. */
export function currentShellIntegration(): ShellIntegrationSettings {
  return useAppStore.getState().settings.shellIntegration ?? defaultShellIntegrationSettings();
}

/**
 * Write shell-integration settings into the store, keeping `settings` and
 * `savedSettings` in lockstep (mirrors `updateSettings`, but for the value
 * persisted out-of-band via the dedicated shell-integration command).
 */
export function writeShellIntegration(nextSi: ShellIntegrationSettings): void {
  useAppStore.setState((s) => {
    const next = { ...s.settings, shellIntegration: nextSi };
    return { settings: next, savedSettings: next };
  });
}

/** Merge the registration facts from a refreshed status back into the store. */
export function syncRegistrationFacts(status: ShellIntegrationStatus): void {
  writeShellIntegration({
    ...currentShellIntegration(),
    registered: status.registered,
    registeredExePath: status.registeredExePath,
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
