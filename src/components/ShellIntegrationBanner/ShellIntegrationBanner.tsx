import { useCallback, useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import { frontendLog } from "@/utils/frontendLog";
import type { ShellIntegrationStatus } from "@/types/connection";
import { Button, toast } from "@/components/ui";
import { getShellIntegrationStatus, installShellIntegration } from "@/services/api";
import { defaultShellIntegrationSettings } from "@/components/Settings/shellIntegrationEntries";
import { INSTALL_TOAST, syncRegistrationFacts } from "@/components/Settings/shellIntegrationStore";
import "./ShellIntegrationBanner.css";

/**
 * Non-blocking first-launch banner offering to add the "Open in termiHub"
 * entries to the user's file manager. Shown once, at the bottom of the app
 * shell, until the integration is registered or the user opts out
 * ("Don't ask again" persists `shellIntegration.firstLaunchBannerDismissed`).
 * Modelled on {@link TerminalViewModeBanner}.
 */
export function ShellIntegrationBanner() {
  const storedSi = useProjectedSettings().shellIntegration;
  const updateShellIntegration = useAppStore((s) => s.updateShellIntegration);
  const si = storedSi ?? defaultShellIntegrationSettings();
  // The banner can never show once dismissed or registered, so it need not even
  // resolve the runtime status in the steady-state case.
  const eligible = !si.firstLaunchBannerDismissed && !si.registered;

  const [status, setStatus] = useState<ShellIntegrationStatus | null>(null);
  const [dismissedThisSession, setDismissedThisSession] = useState(false);

  useEffect(() => {
    if (!eligible) return;
    getShellIntegrationStatus()
      .then(setStatus)
      .catch((e) => frontendLog("shell_integration", `banner status load failed: ${String(e)}`));
  }, [eligible]);

  const persistDismissed = useCallback(async () => {
    try {
      // The store action owns the optimistic write and rollback; it re-throws
      // on failure, which the banner logs (no toast, matching prior behaviour).
      await updateShellIntegration({ ...si, firstLaunchBannerDismissed: true });
    } catch (e) {
      frontendLog("shell_integration", `banner dismiss persist failed: ${String(e)}`);
    }
  }, [si, updateShellIntegration]);

  const handleInstall = useCallback(
    () =>
      toast.promise(
        installShellIntegration().then((st) => {
          setStatus(st);
          syncRegistrationFacts(st);
        }),
        INSTALL_TOAST
      ),
    []
  );

  // Hide until status is known, once registered, after a session dismiss, or
  // when the user opted out permanently.
  if (!eligible || !status || status.registered || dismissedThisSession) {
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
