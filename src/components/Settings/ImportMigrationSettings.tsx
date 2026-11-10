import { useCallback, useEffect, useState } from "react";
import { Archive, Download, FileDown, FileInput, FileSpreadsheet, Upload } from "lucide-react";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { Button, toast } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { useProjectedConnections } from "@/store/useProjectedConnections";
import { discoverMobaxtermConfigs, importInventoryHosts } from "@/services/api";
import { open as openFileDialog } from "@/services/nativeDialog";
import type { InventoryHost } from "@/types/connection";
import { withLoggedFallback } from "@/utils/loggedFallback";
import { frontendError } from "@/utils/frontendLog";
import { errorMessage } from "@/utils/errorMessage";
import { BulkSshImportDialog } from "@/components/Sidebar/BulkSshImportDialog";
import { FleetOnboardDialog } from "@/components/Sidebar/FleetOnboardDialog";
import "./CredentialVault.css";
import "./ImportMigrationSettings.css";

type Discovery = { status: "checking" } | { status: "found"; path: string } | { status: "none" };

/**
 * Settings → Import & Migration (#4850, #5195): the single home for one-time
 * imports and exports. Imports are not daily actions (maintainer decision
 * 2026-10-16), so they live here rather than in the Connections sidebar or the
 * gear menu — the sidebar keeps only one "Import connections…" deep link here.
 *
 * Sections, in order:
 * - `~/.ssh/config` bulk import (`BulkSshImportDialog`, #1731);
 * - CSV / inventory fleet onboarding (`FleetOnboardDialog`, #1961);
 * - JSON connection import / export (the app-level `ImportDialog` /
 *   `ExportDialog`, opened through the store);
 * - MobaXterm migration (the app-level `MobaxtermImportHost`, through the store),
 *   with a hint naming any MobaXterm configuration found on this computer;
 * - a link to Backup & Restore for whole-app backups.
 */
export function ImportMigrationSettings() {
  const setMobaxtermImportOpen = useAppStore((s) => s.setMobaxtermImportOpen);
  const setImportDialog = useAppStore((s) => s.setImportDialog);
  const setExportDialogOpen = useAppStore((s) => s.setExportDialogOpen);
  const bulkAddConnections = useAppStore((s) => s.bulkAddConnections);
  const openSettingsTab = useAppStore((s) => s.openSettingsTab);
  const { folders, connections } = useProjectedConnections();

  const [discovery, setDiscovery] = useState<Discovery>({ status: "checking" });
  const [sshImportOpen, setSshImportOpen] = useState(false);
  const [fleetRows, setFleetRows] = useState<InventoryHost[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void withLoggedFallback(
      discoverMobaxtermConfigs(),
      [],
      "mobaxterm_import",
      "look for a MobaXterm configuration"
    ).then((found) => {
      if (cancelled) return;
      const first = found?.[0];
      setDiscovery(first ? { status: "found", path: first.path } : { status: "none" });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Pick a CSV / inventory file and open the fleet-onboard dialog with its
   * hosts (#1961). A cancelled picker is a no-op; a read/parse failure or an
   * empty/host-less file surfaces a toast rather than an empty dialog.
   */
  const handleImportCsv = useCallback(async () => {
    const selected = await openFileDialog({
      multiple: false,
      filters: [{ name: "Inventory", extensions: ["csv", "txt", "tsv"] }],
    });
    if (typeof selected !== "string") return;
    try {
      const hosts = await importInventoryHosts(selected);
      if (hosts.length === 0) {
        toast.info("No hosts found in that file.");
        return;
      }
      setFleetRows(hosts);
    } catch {
      toast.error("Could not read that inventory file.");
    }
  }, []);

  /** Pick a termiHub connections JSON file and open the import preview. */
  const handleImportJson = useCallback(async () => {
    try {
      const filePath = await openFileDialog({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (typeof filePath !== "string") return;
      const json = await readTextFile(filePath);
      setImportDialog(true, json);
    } catch (err) {
      // Record the read failure in the user-openable LogViewer (OBS-005).
      frontendError("import_migration", `failed to read import file: ${errorMessage(err)}`);
      toast.error("Could not read that connections file.");
    }
  }, [setImportDialog]);

  return (
    <div className="settings-panel__section" data-testid="import-migration-settings">
      <section className="import-migration__group" data-testid="import-migration-ssh-config">
        <h3 className="settings-panel__section-title">Import from ~/.ssh/config</h3>
        <p className="settings-panel__description">
          Create saved SSH connections from the hosts in your OpenSSH client config, including keys
          and jump-host chains. You choose which hosts to import and the target folder.
        </p>
        <div className="credential-vault__actions">
          <Button
            variant="secondary"
            size="sm"
            icon={<FileDown size={14} />}
            onClick={() => setSshImportOpen(true)}
            data-testid="import-migration-ssh-config-btn"
          >
            Import from ~/.ssh/config…
          </Button>
        </div>
      </section>

      <section className="import-migration__group" data-testid="import-migration-inventory">
        <h3 className="settings-panel__section-title">Onboard hosts from a CSV / inventory</h3>
        <p className="settings-panel__description">
          Create many saved connections at once from a CSV, TSV or plain-text inventory file, based
          on an existing connection as a template.
        </p>
        <div className="credential-vault__actions">
          <Button
            variant="secondary"
            size="sm"
            icon={<FileSpreadsheet size={14} />}
            onClick={() => void handleImportCsv()}
            data-testid="import-migration-csv-btn"
          >
            Onboard from a file…
          </Button>
        </div>
      </section>

      <section className="import-migration__group" data-testid="import-migration-json">
        <h3 className="settings-panel__section-title">Import / Export Connections</h3>
        <p className="settings-panel__description">
          Move saved connections and folders between termiHub installs as a JSON file, optionally
          with encrypted credentials.
        </p>
        <div className="credential-vault__actions">
          <Button
            variant="secondary"
            size="sm"
            icon={<Upload size={14} />}
            onClick={() => void handleImportJson()}
            data-testid="import-migration-json-import-btn"
          >
            Import Connections…
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<Download size={14} />}
            onClick={() => setExportDialogOpen(true)}
            data-testid="import-migration-json-export-btn"
          >
            Export Connections…
          </Button>
        </div>
      </section>

      <section className="import-migration__group" data-testid="import-migration-mobaxterm">
        <h3 className="settings-panel__section-title">Import from MobaXterm</h3>
        <p className="settings-panel__description">
          Bring your saved MobaXterm sessions into termiHub, folders included: SSH (with keys and
          jump hosts), Telnet, Serial, RDP, VNC, FTP, local shell and WSL sessions. You see a
          preview and choose what to import. Passwords are never imported.
        </p>
        <p className="import-migration__hint" data-testid="import-migration-mobaxterm-hint">
          {discovery.status === "checking" && "Looking for MobaXterm on this computer…"}
          {discovery.status === "found" && (
            <>
              Found MobaXterm configuration at{" "}
              <span className="import-migration__path">{discovery.path}</span>
            </>
          )}
          {discovery.status === "none" &&
            "No MobaXterm configuration was found on this computer. You can pick a MobaXterm.ini or an exported .mxtsessions file."}
        </p>
        <div className="credential-vault__actions">
          <Button
            variant="secondary"
            size="sm"
            icon={<FileInput size={14} />}
            onClick={() => setMobaxtermImportOpen(true)}
            data-testid="import-migration-mobaxterm-btn"
          >
            Import from MobaXterm…
          </Button>
        </div>
      </section>

      <section className="import-migration__group" data-testid="import-migration-backup">
        <h3 className="settings-panel__section-title">Back up or move everything</h3>
        <p className="settings-panel__description">
          To move all app data — settings, connections, credentials, plugins and host keys — to a
          new machine, use Backup &amp; Restore.
        </p>
        <div className="credential-vault__actions">
          <Button
            variant="secondary"
            size="sm"
            icon={<Archive size={14} />}
            onClick={() => openSettingsTab({ category: "backup" })}
            data-testid="import-migration-backup-link"
          >
            Open Backup &amp; Restore
          </Button>
        </div>
      </section>

      <BulkSshImportDialog
        open={sshImportOpen}
        onOpenChange={setSshImportOpen}
        folders={folders}
        existingConnections={connections}
        onImport={bulkAddConnections}
      />
      <FleetOnboardDialog
        open={fleetRows !== null}
        onOpenChange={(open) => {
          if (!open) setFleetRows(null);
        }}
        rows={fleetRows ?? []}
        sourceLabel="a CSV inventory"
      />
    </div>
  );
}
