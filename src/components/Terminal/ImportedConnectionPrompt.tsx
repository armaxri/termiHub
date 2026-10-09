import { ShieldAlert } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { Button, ContentOverlay, toast } from "@/components/ui";
import { describeImportedConnection } from "@/services/workspaceImportTrust";
import "./ImportedTabConfirmation.css";

interface ImportedConnectionPromptProps {
  tabId: string;
  isVisible: boolean;
}

/**
 * Shown in place of a terminal whose imported inline connection config is not
 * yet confirmed on this machine (#4434). The tab has not connected: nothing has
 * been started. "Confirm and connect" remembers this exact config on this
 * machine and lets the tab connect.
 */
export function ImportedConnectionPrompt({ tabId, isVisible }: ImportedConnectionPromptProps) {
  const tab = useAppStore((s) => s.tabContent[tabId]);
  const confirmConnection = useAppStore((s) => s.confirmImportedTabConnection);

  if (!tab) return null;
  const summary = describeImportedConnection(tab.config);

  const handleConfirm = async () => {
    await confirmConnection(tabId);
    toast.success("Connection confirmed on this machine");
  };

  return (
    <div
      className={`imported-tab-confirm${isVisible ? "" : " imported-tab-confirm--hidden"}`}
      data-testid="imported-connection-prompt"
    >
      <ContentOverlay
        icon={<ShieldAlert size={32} className="imported-tab-confirm__icon" />}
        heading="Imported connection not yet confirmed"
        subheading={
          summary.spawnsLocalProcess
            ? "This tab came from an imported workspace and starts a program on this machine. It has not been opened."
            : "This tab came from an imported workspace. It has not connected."
        }
        actions={
          <Button
            variant="primary"
            size="sm"
            onClick={handleConfirm}
            data-testid="imported-connection-confirm-btn"
          >
            Confirm and connect
          </Button>
        }
      >
        <dl className="imported-tab-confirm__details">
          <div className="imported-tab-confirm__row">
            <dt>Type</dt>
            <dd data-testid="imported-connection-type">{summary.type}</dd>
          </div>
          {summary.target && (
            <div className="imported-tab-confirm__row">
              <dt>Opens</dt>
              <dd data-testid="imported-connection-target">{summary.target}</dd>
            </div>
          )}
          {summary.embeddedCommand && (
            <div className="imported-tab-confirm__row">
              <dt>Runs</dt>
              <dd>
                <code data-testid="imported-connection-embedded-command">
                  {summary.embeddedCommand}
                </code>
              </dd>
            </div>
          )}
          {tab.pendingImportedCommand && (
            <div className="imported-tab-confirm__row">
              <dt>Then</dt>
              <dd>
                <code>{tab.pendingImportedCommand}</code>
                <span className="imported-tab-confirm__hint">(asks again once connected)</span>
              </dd>
            </div>
          )}
        </dl>
      </ContentOverlay>
    </div>
  );
}
