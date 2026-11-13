import { useAppStore } from "@/store/appStore";
import { useAppInfo } from "@/hooks/useAppInfo";
import { StatusDot } from "@/components/ui";
import {
  developUpdateSummary,
  isDevelopUpdate,
} from "@/components/UpdateNotification/developUpdate";

/**
 * Update chip in the status bar. The status bar holds live state only
 * (#5559): the installed version lives in Settings ▸ About, so the chip shows
 * nothing on an up-to-date release build. With an update available it reads
 * "Update v<latest>" with an amber or red dot, and clicking re-shows the update
 * notification popup. A develop-branch build always shows its "develop" badge.
 */
export function UpdateIndicator() {
  const appInfo = useAppInfo();
  const updateInfo = useAppStore((s) => s.updateInfo);
  const updateCheckState = useAppStore((s) => s.updateCheckState);

  const hasUpdate = updateCheckState === "available" && updateInfo?.available === true;
  const isSecurity = hasUpdate && updateInfo?.isSecurity === true;
  const isDevelop = appInfo?.buildBranch === "develop";

  if (!hasUpdate && !isDevelop) return null;

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
        hasUpdate && updateInfo && isDevelopUpdate(updateInfo)
          ? `${developUpdateSummary(updateInfo)} — click to view`
          : hasUpdate
            ? `termiHub v${updateInfo?.latestVersion} is available — click to view`
            : `Develop branch build of termiHub v${appInfo?.version ?? ""}`
      }
      data-testid="update-indicator"
      style={{ cursor: hasUpdate ? "pointer" : "default" }}
    >
      {hasUpdate &&
        (updateInfo && isDevelopUpdate(updateInfo)
          ? "Update"
          : `Update v${updateInfo?.latestVersion ?? ""}`)}
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
        <StatusDot
          tone={isSecurity ? "error" : "notice"}
          size="sm"
          className="update-indicator__dot"
          testId="update-indicator-dot"
          label={isSecurity ? "Security update available" : "Update available"}
        />
      )}
    </button>
  );
}
