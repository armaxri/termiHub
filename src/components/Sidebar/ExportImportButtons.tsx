import { Download, Upload } from "lucide-react";
import { Button, Tooltip } from "@/components/ui";

/**
 * Shared export / import icon-button pair (UISF-019).
 *
 * The Macro, Workflow, and Workspace sidebars each repeated the same trailing
 * pair of icon-only ghost buttons in their toolbar — a `Download` "export all"
 * and an `Upload` "import" — verbatim, differing only in their labels/testids
 * and whether export is disabled when the list is empty. This component owns that
 * pair so the three sidebars compose it instead of re-declaring the markup.
 *
 * It renders the two `<Tooltip><Button/></Tooltip>` pairs the sidebars had
 * before, in the same order, so the rendered DOM (icons, ghost/sm variant,
 * `aria-label`, tooltip text, testids) is unchanged.
 */
export interface ExportImportButtonsProps {
  /** Invoked when the export (Download) button is clicked. */
  onExport: () => void;
  /** Invoked when the import (Upload) button is clicked. */
  onImport: () => void;
  /** Tooltip + `aria-label` for the export button. */
  exportLabel: string;
  /** Tooltip + `aria-label` for the import button. */
  importLabel: string;
  /** Disable the export button (e.g. when there is nothing to export). */
  exportDisabled?: boolean;
  /** `data-testid` for the export button. */
  exportTestId?: string;
  /** `data-testid` for the import button. */
  importTestId?: string;
}

/** The Download/Upload icon-button pair shared by the list-export sidebars. */
export function ExportImportButtons({
  onExport,
  onImport,
  exportLabel,
  importLabel,
  exportDisabled = false,
  exportTestId,
  importTestId,
}: ExportImportButtonsProps) {
  return (
    <>
      <Tooltip content={exportLabel} side="top">
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon={<Download size={14} />}
          onClick={onExport}
          disabled={exportDisabled}
          aria-label={exportLabel}
          data-testid={exportTestId}
        />
      </Tooltip>
      <Tooltip content={importLabel} side="top">
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon={<Upload size={14} />}
          onClick={onImport}
          aria-label={importLabel}
          data-testid={importTestId}
        />
      </Tooltip>
    </>
  );
}
