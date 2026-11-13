import { useCallback, useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import { frontendLog } from "@/utils/frontendLog";
import type { ShellIntegrationStatus } from "@/types/connection";
import { toast } from "@/components/ui";
import { getShellIntegrationStatus, installShellIntegration } from "@/services/api";
import { defaultShellIntegrationSettings } from "@/components/Settings/shellIntegrationEntries";
import { INSTALL_TOAST, syncRegistrationFacts } from "@/components/Settings/shellIntegrationStore";
import { errorMessage } from "@/utils/errorMessage";
import { BottomBanner, BottomBannerAction, useBottomBannerSlot } from "@/components/BottomBanners";

/**
 * Non-blocking first-launch banner offering to add the "Open in termiHub"
 * entries to the user's file manager. Shown once, at the bottom of the app
 * shell, until the integration is registered or the user opts out
 * ("Don't show again" persists `shellIntegration.firstLaunchBannerDismissed`).
 * Modelled on {@link TerminalViewModeBanner}.
 *
 * It is the lowest-ranked bottom banner (#5548): while a crash notice shows it
 * stays hidden and appears once that notice is closed. It shares the bottom
 * banner shell and button pattern with the crash notice (#5638): "Install now"
 * is the main (secondary) action so it never competes with the view's filled
 * primary (#5549); the others are ghost buttons of the same size.
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
      .catch((e) =>
        frontendLog("shell_integration", `banner status load failed: ${errorMessage(e)}`)
      );
  }, [eligible]);

  const persistDismissed = useCallback(async () => {
    try {
      // The store action owns the optimistic write and rollback; it re-throws
      // on failure, which the banner logs (no toast, matching prior behaviour).
      await updateShellIntegration({ ...si, firstLaunchBannerDismissed: true });
    } catch (e) {
      frontendLog("shell_integration", `banner dismiss persist failed: ${errorMessage(e)}`);
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
  const wants = eligible && !!status && !status.registered && !dismissedThisSession;
  // #5548/#5549: a promotional prompt never competes with a crash notice — it
  // ranks last among the bottom banners and waits until the others are closed.
  const active = useBottomBannerSlot("shell-integration", wants);
  if (!wants || !active) {
    return null;
  }

  return (
    <BottomBanner
      tone="info"
      data-testid="shell-integration-banner"
      icon={<FolderOpen size={16} />}
      title="Add “Open in termiHub” to your file manager?"
      description="Right-click any folder to open it directly in termiHub."
      actions={
        <>
          <BottomBannerAction
            onClick={persistDismissed}
            data-testid="shell-integration-banner-dismiss"
          >
            Don't show again
          </BottomBannerAction>
          <BottomBannerAction
            onClick={() => setDismissedThisSession(true)}
            data-testid="shell-integration-banner-not-now"
          >
            Not now
          </BottomBannerAction>
          <BottomBannerAction
            main
            onClick={handleInstall}
            data-testid="shell-integration-banner-install"
          >
            Install now
          </BottomBannerAction>
        </>
      }
    />
  );
}
