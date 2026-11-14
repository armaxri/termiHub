import { Download, RotateCw } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { Button, Progress, toast } from "@/components/ui";
import { errorMessage } from "@/utils/errorMessage";
import { downloadLabel } from "./installRoute";
import "./AppUpdateInstallActions.css";

/** Props for {@link AppUpdateInstallActions}. */
export interface AppUpdateInstallActionsProps {
  /** Prefix of the `data-testid`s (`<prefix>-download`, `<prefix>-restart`, …). */
  testIdPrefix: string;
}

/**
 * The in-app update actions (#5758): "Download and install", the download
 * progress, then "Restart to update". Each step needs its own click; nothing
 * installs on its own. Render only for an update whose `installMethod` is
 * `inApp` — the caller keeps "Open downloads page" next to it as the fallback.
 */
export function AppUpdateInstallActions({ testIdPrefix }: AppUpdateInstallActionsProps) {
  const install = useAppStore((s) => s.appUpdateInstall);
  const downloadAppUpdate = useAppStore((s) => s.downloadAppUpdate);
  const restartToInstallUpdate = useAppStore((s) => s.restartToInstallUpdate);

  const handleDownload = async () => {
    try {
      await downloadAppUpdate();
      toast.success("Update downloaded and verified. Restart to finish.");
    } catch (err) {
      toast.error(`Could not download the update: ${errorMessage(err)}`);
    }
  };

  const handleRestart = async () => {
    try {
      await restartToInstallUpdate();
    } catch (err) {
      toast.error(`Could not install the update: ${errorMessage(err)}`);
    }
  };

  if (install.phase === "downloading") {
    const label = downloadLabel(install.downloaded, install.total);
    return (
      <div className="app-update-install__progress" data-testid={`${testIdPrefix}-progress`}>
        <Progress
          value={install.downloaded}
          max={install.total ?? 0}
          label="Update download progress"
        />
        <span className="app-update-install__label">{label}</span>
      </div>
    );
  }

  if (install.phase === "ready" || install.phase === "restarting") {
    return (
      <Button
        variant="primary"
        size="sm"
        icon={<RotateCw size={12} />}
        onClick={handleRestart}
        disabled={install.phase === "restarting"}
        title="termiHub restarts on the new version; open sessions are closed."
        data-testid={`${testIdPrefix}-restart`}
      >
        {install.phase === "restarting" ? "Restarting…" : "Restart to update"}
      </Button>
    );
  }

  return (
    <Button
      variant="primary"
      size="sm"
      icon={<Download size={12} />}
      onClick={handleDownload}
      data-testid={`${testIdPrefix}-download`}
    >
      Download and install
    </Button>
  );
}
