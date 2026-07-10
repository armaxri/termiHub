import { useCallback, useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { frontendLog } from "@/utils/frontendLog";
import type { ShellIntegrationStatus } from "@/types/connection";
import { Button, toast } from "@/components/ui";
import {
  getShellIntegrationStatus,
  installShellIntegration,
  saveShellIntegrationSettings,
} from "@/services/api";
import { defaultShellIntegrationSettings } from "@/components/Settings/shellIntegrationEntries";
import "./ShellIntegrationBanner.css";

/**
 * Non-blocking first-launch banner offering to add the "Open in termiHub"
 * entries to the user's file manager. Shown once, at the bottom of the app
 * shell, until the integration is registered or the user opts out
 * ("Don't ask again" persists `shellIntegration.firstLaunchBannerDismissed`).
 * Modelled on {@link TerminalViewModeBanner}.
 */
export function ShellIntegrationBanner() {
  const settings = useAppStore((s) => s.settings);
  const si = settings.shellIntegration ?? defaultShellIntegrationSettings();

  const [status, setStatus] = useState<ShellIntegrationStatus | null>(null);
  const [dismissedThisSession, setDismissedThisSession] = useState(false);

  useEffect(() => {
    getShellIntegrationStatus()
      .then(setStatus)
      .catch((e) => frontendLog("shell_integration", `banner status load failed: ${String(e)}`));
  }, []);

  const persistDismissed = useCallback(async () => {
    const current = useAppStore.getState().settings;
    const currentSi = current.shellIntegration ?? defaultShellIntegrationSettings();
    const nextSi = { ...currentSi, firstLaunchBannerDismissed: true };
    const next = { ...current, shellIntegration: nextSi };
    useAppStore.setState({ settings: next, savedSettings: next });
    try {
      await saveShellIntegrationSettings(nextSi);
    } catch (e) {
      frontendLog("shell_integration", `banner dismiss persist failed: ${String(e)}`);
    }
  }, []);

  const handleInstall = useCallback(
    () =>
      toast.promise(installShellIntegration().then(setStatus), {
        loading: "Registering shell integration…",
        success: "Shell integration registered",
        error: (e) => `Registration failed: ${String(e)}`,
      }),
    []
  );

  // Hide until status is known, once registered, after a session dismiss, or
  // when the user opted out permanently.
  if (!status || status.registered || si.firstLaunchBannerDismissed || dismissedThisSession) {
    return null;
  }

  return (
    <div className="shell-integration-banner" data-testid="shell-integration-banner">
      <span className="shell-integration-banner__icon">
        <FolderOpen size={16} />
      </span>
      <div className="shell-integration-banner__text">
        <strong>Add “Open in termiHub” to your file manager?</strong>
        <span>Right-click any folder to open it directly in termiHub.</span>
      </div>
      <div className="shell-integration-banner__actions">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setDismissedThisSession(true)}
          data-testid="shell-integration-banner-not-now"
        >
          Not now
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={persistDismissed}
          data-testid="shell-integration-banner-dismiss"
        >
          Don't ask again
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={handleInstall}
          data-testid="shell-integration-banner-install"
        >
          Install Now
        </Button>
      </div>
    </div>
  );
}
