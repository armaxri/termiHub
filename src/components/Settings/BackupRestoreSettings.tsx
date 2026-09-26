import { useState } from "react";
import { Download, Upload } from "lucide-react";
import { Button } from "@/components/ui";
import { BackupExportDialog } from "./BackupExportDialog";
import { BackupRestoreDialog } from "./BackupRestoreDialog";
import "./CredentialVault.css";

/**
 * Settings → Backup & Restore (PROD-068): back up all app data — connections,
 * settings (incl. themes and keyboard shortcuts), workspaces, macros,
 * workflows, tunnels, embedded servers, network tools and, optionally, the
 * encrypted credential vault — to one file, and restore it.
 */
export function BackupRestoreSettings() {
  const [exportOpen, setExportOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);

  return (
    <div className="settings-panel__section" data-testid="backup-restore-settings">
      <h3 className="settings-panel__section-title">Backup &amp; Restore</h3>
      <p className="settings-panel__description">
        Save everything — connections, settings, themes, keyboard shortcuts, workspaces, macros,
        workflows, tunnels, trusted host keys, plugins and optionally your saved credentials — to
        one passphrase-protected file, to keep a backup or move to another machine. Restore lets you
        pick what to bring back and whether to merge it with or replace what is here.
      </p>
      <div className="credential-vault__actions">
        <Button
          variant="secondary"
          size="sm"
          icon={<Download size={14} />}
          onClick={() => setExportOpen(true)}
          data-testid="backup-export-btn"
        >
          Back up everything…
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
      <BackupExportDialog open={exportOpen} onOpenChange={setExportOpen} />
      <BackupRestoreDialog open={restoreOpen} onOpenChange={setRestoreOpen} />
    </div>
  );
}
