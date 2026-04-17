import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";
import { useAppStore } from "@/store/appStore";

/**
 * Version chip in the status bar.  Shows an amber or red dot when an update
 * is available.  Clicking re-shows the update notification popup.
 */
export function UpdateIndicator() {
  const [appVersion, setAppVersion] = useState("");
  const updateInfo = useAppStore((s) => s.updateInfo);
  const updateCheckState = useAppStore((s) => s.updateCheckState);

  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion("?"));
  }, []);

  const hasUpdate = updateCheckState === "available" && updateInfo?.available === true;
  const isSecurity = hasUpdate && updateInfo?.isSecurity === true;

  const handleClick = () => {
    if (hasUpdate) {
      // Toggle: un-dismiss so the popup reappears.
      useAppStore.setState({ updateNotificationDismissed: false });
    }
  };

  return (
    <button
      className={`status-bar__item${hasUpdate ? " status-bar__item--interactive" : ""}`}
      onClick={hasUpdate ? handleClick : undefined}
      title={
        hasUpdate
          ? `termiHub v${updateInfo?.latestVersion} is available — click to view`
          : `termiHub v${appVersion}`
      }
      data-testid="update-indicator"
      style={{ cursor: hasUpdate ? "pointer" : "default" }}
    >
      v{appVersion}
      {hasUpdate && (
        <span
          className={`update-indicator__dot update-indicator__dot--${isSecurity ? "red" : "amber"}`}
          data-testid="update-indicator-dot"
          aria-label={isSecurity ? "Security update available" : "Update available"}
        />
      )}
    </button>
  );
}
