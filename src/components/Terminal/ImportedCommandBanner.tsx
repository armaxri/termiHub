import { ShieldAlert } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { Button, toast } from "@/components/ui";
import "./ImportedTabConfirmation.css";

interface ImportedCommandBannerProps {
  tabId: string;
}

/**
 * The "imported command not yet confirmed" state of a terminal tab (#4434).
 *
 * A workspace that came from an import carries its tabs' commands as pending:
 * they are shown here and never typed into the session on their own. "Confirm
 * and run" remembers the exact text on this machine and runs it; "Don't run"
 * drops it from this tab. Renders nothing when the tab holds no command.
 */
export function ImportedCommandBanner({ tabId }: ImportedCommandBannerProps) {
  const command = useAppStore((s) => s.tabContent[tabId]?.pendingImportedCommand);
  const connected = useAppStore((s) => Boolean(s.tabContent[tabId]?.sessionId));
  const confirmCommand = useAppStore((s) => s.confirmImportedTabCommand);
  const dismissCommand = useAppStore((s) => s.dismissImportedTabCommand);

  if (!command) return null;

  const handleConfirm = async () => {
    await confirmCommand(tabId);
    toast.success("Command confirmed on this machine and run");
  };

  return (
    <div
      className="imported-command-banner"
      role="region"
      aria-label="Imported command not yet confirmed"
      data-testid="imported-command-banner"
    >
      <ShieldAlert size={16} className="imported-tab-confirm__icon" aria-hidden />
      <div className="imported-command-banner__body">
        <span className="imported-command-banner__title">
          Imported command not yet confirmed. It has not run.
        </span>
        <code className="imported-command-banner__command" data-testid="imported-command-text">
          {command}
        </code>
      </div>
      <div className="imported-command-banner__actions">
        <Button
          variant="primary"
          size="sm"
          onClick={handleConfirm}
          disabled={!connected}
          data-testid="imported-command-confirm-btn"
        >
          Confirm and run
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => dismissCommand(tabId)}
          data-testid="imported-command-dismiss-btn"
        >
          Don&apos;t run
        </Button>
      </div>
    </div>
  );
}
