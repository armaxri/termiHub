import {
  ClipboardPaste,
  CodeXml,
  Columns2,
  Copy,
  CornerLeftUp,
  ExternalLink,
  FilePlus,
  FolderPlus,
  FolderSync,
  Plus,
  RefreshCw,
  Terminal,
  Upload,
} from "lucide-react";
import type React from "react";
import type { FileBrowserAction } from "./FileBrowserActions";
import { FileSortSubmenu, type FileSort } from "./FileSortSubmenu";

import { ICON_SIZE } from "@/components/ui/iconSize";
/** What {@link buildFileBrowserActions} needs to know about the browser. */
export interface FileBrowserActionsInput {
  mode: "local" | "session";
  currentPath: string;
  isLoading: boolean;
  /** Reduced motion: Refresh shows "Refreshing…" instead of a spinning icon. */
  reducedMotion: boolean;
  hasCwd: boolean;
  canCd: boolean;
  showHiddenFiles: boolean;
  vscodeAvailable: boolean;
  /** OS-worded "Reveal in Finder" / "Open in File Explorer" label. */
  fileManagerLabel: string;
  /** Tooltip of Paste when the clipboard holds entries, else `null` (Paste disabled). */
  pasteTooltip: string | null;
  /** The bookmarks sub-menu node for the overflow menu. */
  bookmarksMenu: React.ReactNode;
  onNavigateUp: () => void;
  onNavigateToCwd: () => void;
  onCdHere: () => void;
  onRefresh: () => void;
  onOpenTransferView: () => void;
  onToggleHidden: () => void;
  onOpenInFileManager: () => void;
  onOpenInVscode: () => void;
  onUpload: () => void;
  onPaste: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  /** Copy the current folder's full path to the clipboard (#5624). */
  onCopyPath: () => void;
  /** The file list's active sort, offered as the "Sort by" sub-menu (#5671). */
  sort: FileSort;
  /**
   * Whether the column headers cannot change the sort right now (a column is
   * hidden at this width, #5832). Only then does the menu offer "Sort by":
   * otherwise the headers are the one sort control.
   */
  sortInMenu: boolean;
  onSort: (sort: FileSort) => void;
}

/** Whether `path` is a filesystem root ("/" or a bare drive like "C:/"). */
export function isRootPath(path: string): boolean {
  return path === "/" || /^[A-Za-z]:\/?$/.test(path);
}

/**
 * The file browser's header actions (#5520), in display order. Inline (icon)
 * by usefulness: Up and Refresh are pinned (core navigation, never collapsed);
 * "New ▾" (File / Folder, #5832), Upload (remote only) and Paste (only while
 * the file clipboard holds entries) follow, collapsing into the "…" menu as the
 * sidebar narrows. Everything else is a labelled entry of the overflow menu.
 */
export function buildFileBrowserActions(input: FileBrowserActionsInput): FileBrowserAction[] {
  const refreshing = input.isLoading;
  const actions: FileBrowserAction[] = [
    {
      id: "up",
      label: "Go up one directory",
      tooltip: "Go up",
      // A parent-folder glyph, so Up never reads as Upload's tray-arrow (#5624).
      icon: <CornerLeftUp size={ICON_SIZE.sm} />,
      iconName: "corner-left-up",
      onClick: input.onNavigateUp,
      disabled: isRootPath(input.currentPath),
      testId: "file-browser-up",
      group: "navigate",
      inline: 0,
      pinned: true,
    },
    {
      id: "refresh",
      label: "Refresh file list",
      tooltip: "Refresh",
      icon: (
        <RefreshCw
          size={ICON_SIZE.sm}
          className={refreshing ? "file-browser__spinner motion-essential-spinner" : ""}
        />
      ),
      onClick: input.onRefresh,
      busy: refreshing,
      inlineText: refreshing && input.reducedMotion ? "Refreshing…" : undefined,
      testId: "file-browser-refresh",
      group: "navigate",
      inline: 1,
      pinned: true,
    },
    {
      // One slot for both creations (#5832): "New ▾" opens File / Folder.
      id: "new",
      label: "New",
      tooltip: "New file or folder",
      icon: <Plus size={ICON_SIZE.sm} />,
      iconName: "plus",
      testId: "file-browser-new",
      group: "create",
      inline: 4,
      children: [
        {
          id: "new-file",
          label: "File",
          icon: <FilePlus size={ICON_SIZE.sm} />,
          onClick: input.onNewFile,
          opensField: true,
          testId: "file-browser-new-file",
          group: "create",
        },
        {
          id: "new-folder",
          label: "Folder",
          icon: <FolderPlus size={ICON_SIZE.sm} />,
          onClick: input.onNewFolder,
          opensField: true,
          testId: "file-browser-new-folder",
          group: "create",
        },
      ],
    },
  ];
  if (input.mode === "session") {
    actions.push({
      id: "upload",
      label: "Upload file",
      icon: <Upload size={ICON_SIZE.sm} />,
      iconName: "upload",
      onClick: input.onUpload,
      testId: "file-browser-upload",
      group: "create",
      inline: 3,
    });
  }
  actions.push(
    {
      id: "paste",
      label: "Paste",
      tooltip: input.pasteTooltip ?? "Paste",
      icon: <ClipboardPaste size={ICON_SIZE.sm} />,
      onClick: input.onPaste,
      disabled: input.pasteTooltip === null,
      testId: "file-browser-paste",
      group: "create",
      // Contextual: an icon only while there is something to paste.
      inline: input.pasteTooltip === null ? undefined : 2,
    },
    {
      id: "go-to-cwd",
      // A command, so a command's name: "Follow …" read as a toggle (#5832).
      label: "Go to terminal folder",
      tooltip: "Go to the terminal's working directory",
      icon: <FolderSync size={ICON_SIZE.sm} />,
      onClick: input.onNavigateToCwd,
      disabled: !input.hasCwd,
      testId: "file-browser-go-to-cwd",
      group: "navigate",
    },
    {
      id: "copy-path",
      label: "Copy path",
      icon: <Copy size={ICON_SIZE.sm} />,
      onClick: input.onCopyPath,
      testId: "file-browser-copy-path",
      group: "navigate",
    },
    {
      id: "bookmarks",
      label: "Bookmarks",
      icon: null,
      testId: "file-browser-bookmarks",
      group: "navigate",
      menuNode: input.bookmarksMenu,
    },
    {
      id: "cd-here",
      label: input.canCd
        ? "Open this folder in terminal"
        : "Open this folder in terminal (no active terminal)",
      icon: <Terminal size={ICON_SIZE.sm} />,
      onClick: input.onCdHere,
      disabled: !input.canCd,
      testId: "file-browser-cd-here",
      group: "terminal",
    },
    {
      id: "toggle-hidden",
      label: "Show hidden files",
      // A toggle: its tick sits in the icon column of the menu (#5832).
      icon: null,
      onClick: input.onToggleHidden,
      checked: input.showHiddenFiles,
      testId: "file-browser-toggle-hidden",
      group: "view",
    },
    {
      id: "transfer-view",
      label: "Open dual-pane transfer view",
      icon: <Columns2 size={ICON_SIZE.sm} />,
      onClick: input.onOpenTransferView,
      testId: "file-browser-open-transfer-view",
      group: "view",
    }
  );
  if (input.sortInMenu) {
    const toggleIndex = actions.findIndex((a) => a.id === "toggle-hidden");
    actions.splice(toggleIndex, 0, {
      id: "sort",
      label: "Sort by",
      icon: null,
      testId: "file-browser-sort-menu",
      group: "view",
      menuNode: <FileSortSubmenu sort={input.sort} onSort={input.onSort} />,
    });
  }
  if (input.mode === "local") {
    actions.push({
      id: "open-in-explorer",
      label: input.fileManagerLabel,
      icon: <ExternalLink size={ICON_SIZE.sm} />,
      onClick: input.onOpenInFileManager,
      testId: "file-browser-open-in-explorer",
      group: "open",
    });
    if (input.vscodeAvailable) {
      actions.push({
        id: "open-folder-vscode",
        label: "Open folder in VS Code",
        icon: <CodeXml size={ICON_SIZE.sm} />,
        onClick: input.onOpenInVscode,
        testId: "file-browser-open-folder-vscode",
        group: "open",
      });
    }
  }
  return actions;
}
