import { useEffect, useState } from "react";
import { useAppStore } from "@/store/appStore";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import { fireAndForget, frontendLog } from "@/utils/frontendLog";
import type { ShellIntegrationStatus } from "@/types/connection";
import { toast } from "@/components/ui";
import { getShellIntegrationStatus, installShellIntegration } from "@/services/api";
import { INSTALL_TOAST, syncRegistrationFacts } from "@/components/Settings/shellIntegrationStore";
import { crashChecksDone, useBottomBannerStore } from "@/components/BottomBanners";
import { errorMessage } from "@/utils/errorMessage";

/** Id of the offer toast, so it can be taken down when a crash notice appears. */
export const FILE_MANAGER_OFFER_TOAST_ID = "file-manager-offer";

/**
 * Whether the offer was raised in this window's session already. Module scope,
 * not a ref, so a remount (React strict mode, a layout switch) never raises it
 * a second time.
 */
let offeredThisSession = false;

/** Test-only: forget that the offer was raised. */
export function __resetFileManagerOfferForTest(): void {
  offeredThisSession = false;
}

/**
 * The one-time "Open in termiHub" file-manager offer (#5753): a toast with
 * "Install" (the action) and "Not now" (the cancel); closing it is the same as
 * "Not now". It replaces the docked first-launch banner, and the same install
 * stays available in Settings › File manager integration (#5616).
 *
 * - **Once.** It persists `shellIntegration.firstLaunchBannerDismissed` the
 *   moment it is shown, so it never comes back on a later launch whatever the
 *   user does with it. The field keeps its name: a profile that pressed the old
 *   banner's "Don't show again" already has it set and is never offered again.
 * - **Never beside a crash notice.** It waits until both startup crash checks
 *   (local and agent, see `markCrashChecked`) have finished and stays away for
 *   the whole session when either found one; it is then offered on a later,
 *   crash-free launch. A crash notice that turns up while the toast is showing
 *   (an agent crash pushed after a connect) takes the toast down.
 * - **Persistent.** An offer with two buttons does not auto-dismiss: it stays
 *   until the user answers it (sonner's non-finite duration).
 *
 * Renders nothing itself; the toast hub draws the toast.
 */
export function FileManagerOffer() {
  const storedSi = useProjectedSettings().shellIntegration;
  const updateShellIntegration = useAppStore((s) => s.updateShellIntegration);
  const crashChecked = useBottomBannerStore(crashChecksDone);
  const crashThisSession = useBottomBannerStore((s) => s.crashNoticeThisSession);
  // Only once the persisted document is in (the pre-load default has no
  // `shellIntegration`): a stale default must never raise the offer again.
  const eligible =
    storedSi !== undefined && !storedSi.firstLaunchBannerDismissed && !storedSi.registered;

  const [status, setStatus] = useState<ShellIntegrationStatus | null>(null);

  useEffect(() => {
    if (!eligible || offeredThisSession) return;
    let cancelled = false;
    getShellIntegrationStatus()
      .then((st) => {
        if (!cancelled) setStatus(st);
      })
      .catch((e) =>
        frontendLog("shell_integration", `offer status load failed: ${errorMessage(e)}`)
      );
    return () => {
      cancelled = true;
    };
  }, [eligible]);

  useEffect(() => {
    if (!eligible || !storedSi || offeredThisSession) return;
    if (!status || status.registered || !crashChecked || crashThisSession) return;
    offeredThisSession = true;
    toast.info("Add “Open in termiHub” to your file manager?", {
      id: FILE_MANAGER_OFFER_TOAST_ID,
      testId: "file-manager-offer",
      description:
        "Right-click any folder to open it in termiHub. You can also do this later in Settings › File manager integration.",
      duration: Infinity,
      action: {
        label: "Install",
        testId: "file-manager-offer-install",
        onClick: () => {
          // INSTALL_TOAST reports a failure to the user; this only logs it.
          fireAndForget(
            toast.promise(installShellIntegration(), INSTALL_TOAST).then(syncRegistrationFacts),
            "file-manager offer install"
          );
        },
      },
      cancel: {
        label: "Not now",
        testId: "file-manager-offer-not-now",
        onClick: () => {},
      },
    });
    // Shown once: remember it right away, so neither answering nor quitting
    // with the toast still up brings it back on the next launch.
    updateShellIntegration({ ...storedSi, firstLaunchBannerDismissed: true }).catch((e) =>
      frontendLog("shell_integration", `offer shown persist failed: ${errorMessage(e)}`)
    );
  }, [eligible, storedSi, status, crashChecked, crashThisSession, updateShellIntegration]);

  // A crash notice later in the session (an agent crash pushed after a
  // connect) outranks the offer: take it down.
  useEffect(() => {
    if (crashThisSession && offeredThisSession) toast.dismiss(FILE_MANAGER_OFFER_TOAST_ID);
  }, [crashThisSession]);

  return null;
}
