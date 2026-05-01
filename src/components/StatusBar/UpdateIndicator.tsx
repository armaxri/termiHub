import { useEffect, useState } from "react";
import { useAppStore } from "@/store/appStore";
import { getAppInfo, type AppInfo } from "@/services/api";

/**
 * Version chip in the status bar.  Shows an amber or red dot when an update
 * is available.  Clicking re-shows the update notification popup.
 * Shows a "develop" badge when running a develop-branch build.
 */
export function UpdateIndicator() {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const updateInfo = useAppStore((s) => s.updateInfo);
  const updateCheckState = useAppStore((s) => s.updateCheckState);

  useEffect(() => {
    getAppInfo()
      .then(setAppInfo)
      .catch(() => null);
  }, []);

  const hasUpdate = updateCheckState === "available" && updateInfo?.available === true;
  const isSecurity = hasUpdate && updateInfo?.isSecurity === true;
  const isDevelop = appInfo?.buildBranch === "develop";

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
          : `termiHub v${appInfo?.version ?? ""}`
      }
      data-testid="update-indicator"
      style={{ cursor: hasUpdate ? "pointer" : "default" }}
    >
      v{appInfo?.version ?? ""}
      {isDevelop && (
        <span
          className="update-indicator__develop-badge"
          data-testid="develop-branch-badge"
          aria-label="Develop branch build"
        >
          develop
        </span>
      )}
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
