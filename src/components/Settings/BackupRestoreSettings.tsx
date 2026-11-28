import { useState } from "react";
import { Download, Upload } from "lucide-react";
import { Button } from "@/components/ui";
import { RestoredOffDialog } from "@/components/RestoredOff/RestoredOffDialog";
import { useRestoredOff } from "@/components/RestoredOff/useRestoredOff";
import { BackupExportDialog } from "./BackupExportDialog";
import { BackupRestoreDialog } from "./BackupRestoreDialog";
import { OlderPasswordImport } from "./OlderPasswordImport";
import "./CredentialVault.css";
import { SettingsSectionHeading } from "./SettingsSectionHeading";

import { ICON_SIZE } from "@/components/ui/iconSize";
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
 * saved passwords — to one file, and restore it. It is the one backup flow
 * (#5860, R-052): Security links here, and an older passwords-only export is
 * restored here too ({@link OlderPasswordImport}).
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
        Save your connections, settings and saved passwords to one passphrase-locked file, and
        restore it on any computer.
      </p>
      <div className="credential-vault__actions">
        <Button
          variant="secondary"
          size="sm"
          icon={<Download size={ICON_SIZE.sm} />}
          onClick={() => setExportOpen(true)}
          data-testid="backup-export-btn"
        >
          Back up…
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon={<Upload size={ICON_SIZE.sm} />}
          onClick={() => setRestoreOpen(true)}
          data-testid="backup-restore-btn"
        >
          Restore…
        </Button>
      </div>
      {entries.length > 0 && (
        <div className="backup-restore__still-off" data-testid="backup-restored-off">
          <span>{restoredOffText(entries.length)}</span>
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
      <OlderPasswordImport />
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
