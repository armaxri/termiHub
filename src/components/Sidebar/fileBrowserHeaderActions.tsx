import {
  ClipboardPaste,
  CodeXml,
  Columns2,
  Copy,
  CornerLeftUp,
  ExternalLink,
  Eye,
  FilePlus,
  FolderPlus,
  FolderSync,
  RefreshCw,
  Terminal,
  Upload,
} from "lucide-react";
import type React from "react";
import type { FileBrowserAction } from "./FileBrowserActions";
import { FileSortSubmenu, type FileSort } from "./FileSortSubmenu";

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
  onSort: (sort: FileSort) => void;
}

/** Whether `path` is a filesystem root ("/" or a bare drive like "C:/"). */
export function isRootPath(path: string): boolean {
  return path === "/" || /^[A-Za-z]:\/?$/.test(path);
}

/**
 * The file browser's header actions (#5520), in display order. Inline (icon)
 * by usefulness: Up and Refresh are pinned (core navigation, never collapsed);
 * New file, New folder, Upload (remote only) and Paste (only while the file
 * clipboard holds entries) follow, collapsing into the "…" menu as the sidebar
 * narrows. Everything else is a labelled entry of the overflow menu.
 */
export function buildFileBrowserActions(input: FileBrowserActionsInput): FileBrowserAction[] {
  const refreshing = input.isLoading;
  const actions: FileBrowserAction[] = [
    {
      id: "up",
      label: "Go up one directory",
      tooltip: "Go up",
      // A parent-folder glyph, so Up never reads as Upload's tray-arrow (#5624).
      icon: <CornerLeftUp size={14} />,
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
          size={14}
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
      id: "new-file",
      label: "New file",
      icon: <FilePlus size={14} />,
      onClick: input.onNewFile,
      testId: "file-browser-new-file",
      group: "create",
      inline: 5,
    },
    {
      id: "new-folder",
      label: "New folder",
      icon: <FolderPlus size={14} />,
      onClick: input.onNewFolder,
      testId: "file-browser-new-folder",
      group: "create",
      inline: 4,
    },
  ];
  if (input.mode === "session") {
    actions.push({
      id: "upload",
      label: "Upload file",
      icon: <Upload size={14} />,
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
      icon: <ClipboardPaste size={14} />,
      onClick: input.onPaste,
      disabled: input.pasteTooltip === null,
      testId: "file-browser-paste",
      group: "create",
      // Contextual: an icon only while there is something to paste.
      inline: input.pasteTooltip === null ? undefined : 2,
    },
    {
      id: "go-to-cwd",
      label: "Follow terminal folder",
      tooltip: "Go to the terminal's working directory",
      icon: <FolderSync size={14} />,
      onClick: input.onNavigateToCwd,
      disabled: !input.hasCwd,
      testId: "file-browser-go-to-cwd",
      group: "navigate",
    },
    {
      id: "copy-path",
      label: "Copy path",
      icon: <Copy size={14} />,
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
      icon: <Terminal size={14} />,
      onClick: input.onCdHere,
      disabled: !input.canCd,
      testId: "file-browser-cd-here",
      group: "terminal",
    },
    {
      id: "sort",
      label: "Sort by",
      icon: null,
      testId: "file-browser-sort-menu",
      group: "view",
      menuNode: <FileSortSubmenu sort={input.sort} onSort={input.onSort} />,
    },
    {
      id: "toggle-hidden",
      label: "Show hidden files",
      icon: <Eye size={14} />,
      onClick: input.onToggleHidden,
      checked: input.showHiddenFiles,
      testId: "file-browser-toggle-hidden",
      group: "view",
    },
    {
      id: "transfer-view",
      label: "Open dual-pane transfer view",
      icon: <Columns2 size={14} />,
      onClick: input.onOpenTransferView,
      testId: "file-browser-open-transfer-view",
      group: "view",
    }
  );
  if (input.mode === "local") {
    actions.push({
      id: "open-in-explorer",
      label: input.fileManagerLabel,
      icon: <ExternalLink size={14} />,
      onClick: input.onOpenInFileManager,
      testId: "file-browser-open-in-explorer",
      group: "open",
    });
    if (input.vscodeAvailable) {
      actions.push({
        id: "open-folder-vscode",
        label: "Open folder in VS Code",
        icon: <CodeXml size={14} />,
        onClick: input.onOpenInVscode,
        testId: "file-browser-open-folder-vscode",
        group: "open",
      });
    }
  }
  return actions;
}
