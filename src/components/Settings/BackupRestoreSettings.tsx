import { useState } from "react";
import { Download, Upload } from "lucide-react";
import { Button } from "@/components/ui";
import { RestoredOffDialog } from "@/components/RestoredOff/RestoredOffDialog";
import { useRestoredOff } from "@/components/RestoredOff/useRestoredOff";
import { BackupExportDialog } from "./BackupExportDialog";
import { BackupRestoreDialog } from "./BackupRestoreDialog";
import "./CredentialVault.css";
import { SettingsSectionHeading } from "./SettingsSectionHeading";

/** "2 restored entries that start by themselves are still off." */
export function restoredOffText(count: number): string {
  return count === 1
    ? "1 restored entry that starts by itself is still off."
    : `${count} restored entries that start by themselves are still off.`;
}

/**
 * Settings → Backup & restore (PROD-068): back up all app data — connections,
 * settings (incl. themes and keyboard shortcuts), workspaces, macros,
 * workflows, tunnels, embedded servers, network tools and, optionally, the
 * encrypted credential vault — to one file, and restore it.
 */
export function BackupRestoreSettings() {
  const [exportOpen, setExportOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [offOpen, setOffOpen] = useState(false);
  const { entries, setEntries } = useRestoredOff();

  return (
    <div className="settings-panel__section" data-testid="backup-restore-settings">
      <SettingsSectionHeading>Backup &amp; restore</SettingsSectionHeading>
      <p className="settings-panel__description" data-testid="backup-restore-description">
        Save your connections, settings and other data to one file, and restore it here or on
        another computer.
      </p>
      <div className="credential-vault__actions">
        <Button
          variant="secondary"
          size="sm"
          icon={<Download size={14} />}
          onClick={() => setExportOpen(true)}
          data-testid="backup-export-btn"
        >
          Back up…
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon={<Upload size={14} />}
          onClick={() => setRestoreOpen(true)}
          data-testid="backup-restore-btn"
        >
          Restore…
        </Button>
      </div>
      {entries.length > 0 && (
        <div className="credential-vault__actions" data-testid="backup-restored-off">
          <span className="settings-panel__description">{restoredOffText(entries.length)}</span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setOffOpen(true)}
            data-testid="backup-restored-off-review"
          >
            Review…
          </Button>
        </div>
      )}
      <RestoredOffDialog
        open={offOpen}
        entries={entries}
        onLater={() => setOffOpen(false)}
        onDone={(left) => {
          setEntries(left);
          if (left.length === 0) setOffOpen(false);
        }}
      />
      <BackupExportDialog open={exportOpen} onOpenChange={setExportOpen} />
      <BackupRestoreDialog open={restoreOpen} onOpenChange={setRestoreOpen} />
    </div>
  );
}
