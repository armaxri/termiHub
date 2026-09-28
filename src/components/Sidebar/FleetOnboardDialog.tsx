import { useEffect, useMemo, useRef, useState } from "react";
import { Server } from "lucide-react";
import { Button, Checkbox, Modal, Select } from "@/components/ui";
import { toast } from "@/components/ui";
import type { InventoryHost, SavedConnection } from "@/types/connection";
import { useAppStore } from "@/store/appStore";
import { useProjectedConnections } from "@/store/useProjectedConnections";
import {
  importFolderOptions,
  resolveImportFolderId,
  ROOT_FOLDER_VALUE,
} from "@/services/sshConfigImport";
import { buildTemplatedConnections, isHostTemplate } from "@/services/fleetOnboard";
import { compareNames } from "@/utils/locale";
import "./BulkSshImportDialog.css";
import "./FleetOnboardDialog.css";

interface FleetOnboardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The hosts to onboard, from a CSV inventory or a network-scan result. */
  rows: InventoryHost[];
  /** Where the rows came from, shown in the dialog copy (e.g. "CSV inventory"). */
  sourceLabel: string;
}

/** One-line summary of a row's per-host overrides, or "" when it inherits all. */
function overrideSummary(row: InventoryHost): string {
  const parts: string[] = [];
  if (row.username) parts.push(`user ${row.username}`);
  if (row.port !== undefined) parts.push(`port ${row.port}`);
  return parts.join(" · ");
}

/**
 * Fleet-onboard dialog (#1961): create many saved connections from one existing
 * connection used as a **template**, sourcing the hosts from a CSV inventory.
 * The user picks the template connection (only host-based types are offered, and
 * nothing is pre-selected), a target
 * folder, and whether to skip hosts that already exist; each row becomes a saved
 * connection reusing the template's type and settings with its host (and any
 * per-row port/username) stamped in.
 *
 * Self-contained on the store (templates, folders, bulk-add) so the connection
 * list can open it with just a `rows` array.
 */
export function FleetOnboardDialog({
  open,
  onOpenChange,
  rows,
  sourceLabel,
}: FleetOnboardDialogProps) {
  const { connections, folders } = useProjectedConnections();
  const bulkAddConnections = useAppStore((s) => s.bulkAddConnections);
  const connectionTypes = useAppStore((s) => s.connectionTypes);

  const [templateId, setTemplateId] = useState<string>("");
  const [folderId, setFolderId] = useState<string>(ROOT_FOLDER_VALUE);
  const [dedupe, setDedupe] = useState(true);

  const templateCandidates = useMemo(
    () => connections.filter((c) => isHostTemplate(c, connectionTypes)),
    [connections, connectionTypes]
  );
  const templateOptions = useMemo(
    () =>
      templateCandidates
        .map((c) => ({ value: c.id, label: `${c.name} (${c.config.type})` }))
        .sort((a, b) => compareNames(a.label, b.label)),
    [templateCandidates]
  );
  const folderOptions = useMemo(() => importFolderOptions(folders), [folders]);

  // Reset the form only on the closed -> open transition. Depending on the
  // connections projection here would wipe the user's picked template whenever
  // the projection re-emits while the dialog is open (#3813).
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setFolderId(ROOT_FOLDER_VALUE);
      setDedupe(true);
      // No default: the user must pick the template explicitly, so hosts are
      // never silently stamped from whichever connection happens to be first.
      setTemplateId("");
    }
    wasOpen.current = open;
  }, [open]);

  const template: SavedConnection | undefined = templateCandidates.find((c) => c.id === templateId);
  const noTemplates = templateCandidates.length === 0;
  const canImport = !!template && rows.length > 0;

  const handleImport = () => {
    if (!template) return;
    const { connections: built, skipped } = buildTemplatedConnections(
      rows,
      template,
      resolveImportFolderId(folderId),
      connections,
      { dedupe }
    );
    if (built.length === 0) {
      toast.info(
        skipped.length > 0
          ? `All ${skipped.length} host${skipped.length === 1 ? "" : "s"} already exist here — nothing to add.`
          : "No hosts to add."
      );
      onOpenChange(false);
      return;
    }
    bulkAddConnections(built);
    if (skipped.length > 0) {
      toast.info(
        `Skipped ${skipped.length} host${skipped.length === 1 ? "" : "s"} already present in this folder.`
      );
    }
    onOpenChange(false);
  };

  const addLabel = canImport && template ? `Add ${rows.length}` : "Add";

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Onboard hosts from a template"
      description={`Create a saved connection per host from ${sourceLabel}, reusing an existing connection as the template.`}
      size="lg"
      data-testid="fleet-onboard-dialog"
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            data-testid="fleet-onboard-cancel"
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleImport}
            disabled={!canImport}
            data-testid="fleet-onboard-import"
          >
            {addLabel}
          </Button>
        </>
      }
    >
      {noTemplates ? (
        <div className="ssh-config-import__empty" data-testid="fleet-onboard-no-templates">
          <Server size={20} aria-hidden />
          <p>
            Create a host-based connection (e.g. SSH or Telnet) first, then use it as a template to
            onboard hosts in bulk.
          </p>
        </div>
      ) : rows.length === 0 ? (
        <div className="ssh-config-import__empty" data-testid="fleet-onboard-empty">
          <Server size={20} aria-hidden />
          <p>No hosts to onboard from {sourceLabel}.</p>
        </div>
      ) : (
        <div className="bulk-ssh-import">
          <div className="bulk-ssh-import__folder">
            <label className="bulk-ssh-import__folder-label" htmlFor="fleet-onboard-template">
              Template connection
            </label>
            <Select
              value={templateId}
              onChange={setTemplateId}
              options={templateOptions}
              placeholder="Pick a connection to copy"
              aria-label="Template connection"
              data-testid="fleet-onboard-template"
            />
          </div>

          <div className="bulk-ssh-import__folder">
            <label className="bulk-ssh-import__folder-label" htmlFor="fleet-onboard-folder">
              Import into
            </label>
            <Select
              value={folderId}
              onChange={setFolderId}
              options={folderOptions}
              aria-label="Target folder"
              data-testid="fleet-onboard-folder"
            />
          </div>

          <label className="fleet-onboard__dedupe">
            <Checkbox
              checked={dedupe}
              onCheckedChange={(checked) => setDedupe(checked === true)}
              aria-label="Skip hosts that already exist"
              data-testid="fleet-onboard-dedupe"
            />
            <span className="bulk-ssh-import__selectall-label">
              Skip hosts already present in the target folder
            </span>
          </label>

          <div className="bulk-ssh-import__selectall">
            <span className="bulk-ssh-import__selectall-label">
              {rows.length} host{rows.length === 1 ? "" : "s"} to onboard
            </span>
          </div>

          <ul className="ssh-config-import__list" data-testid="fleet-onboard-list">
            {rows.map((row, i) => {
              const overrides = overrideSummary(row);
              return (
                <li key={`${row.host}-${i}`}>
                  <div
                    className="fleet-onboard__row"
                    data-testid={`fleet-onboard-host-${row.host}`}
                  >
                    <span className="ssh-config-import__row-text">
                      <span className="ssh-config-import__row-name">{row.label}</span>
                      <span className="ssh-config-import__row-chain">
                        {row.host}
                        {overrides ? ` · ${overrides}` : ""}
                      </span>
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Modal>
  );
}
