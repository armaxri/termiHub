import { Download, Upload } from "lucide-react";
import type { ToolbarAction } from "@/components/ui";

/**
 * Shared export / import icon-button pair (UISF-019).
 *
 * The Macro, Workflow, and Workspace sidebars each repeated the same trailing
 * pair of icon-only ghost buttons in their toolbar — a `Download` "export all"
 * and an `Upload` "import" — verbatim, differing only in their labels/testids
 * and whether export is disabled when the list is empty. {@link exportImportActions}
 * owns that pair so the three sidebars compose it instead of re-declaring it;
 * the toolbar renders each as a tooltipped, `aria-label`led icon button with the
 * caller's testid (or an overflow-menu item when the sidebar is narrow).
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

/**
 * The Download/Upload pair as icon-only {@link ToolbarAction}s for a
 * width-responsive `SidebarToolbar` (#4709) — so the pair collapses into the
 * overflow menu instead of clipping in a narrow sidebar.
 */
export function exportImportActions({
  onExport,
  onImport,
  exportLabel,
  importLabel,
  exportDisabled = false,
  exportTestId,
  importTestId,
}: ExportImportButtonsProps): ToolbarAction[] {
  return [
    {
      id: "export",
      label: exportLabel,
      icon: <Download size={14} />,
      onClick: onExport,
      disabled: exportDisabled,
      iconOnly: true,
      testId: exportTestId,
    },
    {
      id: "import",
      label: importLabel,
      icon: <Upload size={14} />,
      onClick: onImport,
      iconOnly: true,
      testId: importTestId,
    },
  ];
}
