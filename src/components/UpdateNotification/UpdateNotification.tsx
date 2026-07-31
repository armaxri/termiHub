import { useState, useEffect } from "react";
import { X, Shield, RefreshCw } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAppStore } from "@/store/appStore";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import { Button } from "@/components/ui";
import { useDesktopVersion } from "@/hooks/useAppInfo";
import { frontendLog } from "@/utils/frontendLog";
import "./UpdateNotification.css";

/**
 * Non-blocking update notification popup.
 *
 * Shown once when a new version is detected.  Security updates omit the
 * "Skip This Version" action.  The status-bar dot remains visible after
 * dismiss so the user can always revisit the popup by clicking the version
 * chip.
 */
export function UpdateNotification() {
  const updateInfo = useAppStore((s) => s.updateInfo);
  const updateNotificationDismissed = useAppStore((s) => s.updateNotificationDismissed);
  const dismissUpdateNotification = useAppStore((s) => s.dismissUpdateNotification);
  const skipUpdate = useAppStore((s) => s.skipUpdate);
  const settings = useProjectedSettings();

  const [showNotes, setShowNotes] = useState(false);
  const runningVersion = useDesktopVersion();

  // Reset "what's new" panel whenever the detected version changes.
  useEffect(() => {
    setShowNotes(false);
  }, [updateInfo?.latestVersion]);

  const visible = updateInfo?.available === true && !updateNotificationDismissed;

  if (!visible || !updateInfo) return null;

  const isSecurity = updateInfo.isSecurity;
  const skippedVersion = settings.updates?.skippedVersion;
  // For non-security updates: don't show the popup if the user already
  // skipped this exact version (the dot still appears).
  if (!isSecurity && skippedVersion === updateInfo.latestVersion) return null;

  const handleOpenDownloads = async () => {
    try {
      await openUrl(updateInfo.releaseUrl);
    } catch (err) {
      frontendLog("update", `Failed to open release URL: ${err}`);
      throw new Error("Could not open the downloads page in your browser.");
    }
    dismissUpdateNotification();
  };

  const handleSkip = async () => {
    await skipUpdate();
  };

  return (
    <div
      className={`update-notification ${isSecurity ? "update-notification--security" : ""}`}
      role="alertdialog"
      aria-labelledby="update-notification-title"
      data-testid="update-notification"
    >
      <div className="update-notification__header">
        <div className="update-notification__title-row">
          {isSecurity ? (
            <Shield
              size={14}
              className="update-notification__icon update-notification__icon--security"
            />
          ) : (
            <span className="update-notification__dot update-notification__dot--amber" />
          )}
          <span id="update-notification-title" className="update-notification__title">
            {isSecurity
              ? `Security update: termiHub v${updateInfo.latestVersion}`
              : `termiHub v${updateInfo.latestVersion} is available`}
          </span>
        </div>
        <button
          className="update-notification__close"
          onClick={dismissUpdateNotification}
          aria-label="Dismiss update notification"
          data-testid="update-notification-close"
        >
          <X size={14} />
        </button>
      </div>

      <div className="update-notification__body">
        {isSecurity ? (
          <p className="update-notification__message">
            This release addresses a security vulnerability. Updating is strongly recommended.
          </p>
        ) : (
          <p className="update-notification__message">
            {runningVersion ? `You are running v${runningVersion}` : "A newer version is available"}
          </p>
        )}

        {showNotes && updateInfo.releaseNotes && (
          <div className="update-notification__notes" data-testid="update-notification-notes">
            <pre className="update-notification__notes-body">{updateInfo.releaseNotes}</pre>
          </div>
        )}
      </div>

      <div className="update-notification__actions">
        {updateInfo.releaseNotes && (
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw size={12} />}
            onClick={() => setShowNotes((v) => !v)}
            data-testid="update-notification-whats-new"
          >
            {showNotes ? "Hide" : "What's New"}
          </Button>
        )}
        <Button
          variant="primary"
          size="sm"
          onClick={handleOpenDownloads}
          data-testid="update-notification-open-downloads"
        >
          Open Downloads Page
        </Button>
        {!isSecurity && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleSkip}
            data-testid="update-notification-skip"
          >
            Skip This Version
          </Button>
        )}
      </div>
    </div>
  );
}
