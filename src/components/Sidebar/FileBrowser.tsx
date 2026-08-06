import { useCallback, useState, useEffect, useRef, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { writeText as writeClipboard } from "@tauri-apps/plugin-clipboard-manager";
import {
  Folder,
  File,
  FileSymlink,
  FolderSymlink,
  ArrowUp,
  RefreshCw,
  Upload,
  FolderPlus,
  Unplug,
  Loader2,
  AlertCircle,
  Download,
  Pencil,
  Trash2,
  MoreHorizontal,
  FolderOpen,
  MonitorOff,
  CodeXml,
  FileEdit,
  FilePlus,
  Copy,
  Scissors,
  ClipboardPaste,
  FolderSync,
  Globe,
  Terminal,
  X,
  Ban,
  Search,
  ChevronUp,
  ChevronDown,
} from "lucide-react";
import { useAppStore, getActiveTab } from "@/store/appStore";
import { useProjectedAgents } from "@/store/useProjectedAgents";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import { useProjectedFileBrowsers } from "@/store/useProjectedFileBrowsers";
import { Button, Tooltip, Progress, Input, toast } from "@/components/ui";
import { useFileBrowser } from "@/hooks/useFileBrowser";
import { onVscodeEditComplete } from "@/services/events";
import { getHomeDir, sendInput } from "@/services/api";
import { FileEntry } from "@/types/connection";
import type { ShellType } from "@/types/terminal";
import type { ConnectionTypeInfo } from "@/services/api";
import { getWslDistroName, wslToWindowsPath, windowsToWslPath } from "@/utils/shell-detection";
import { formatBytes, formatRelativeTime } from "@/utils/formatters";
import {
  sortEntries,
  filterEntries,
  resolveSymlinkTarget,
  type FileSortKey,
  type SortDirection,
} from "@/utils/fileBrowserNav";
import { resolveFeatureEnabled } from "@/utils/featureFlags";
import { baseNameSelectionEnd } from "@/utils/fileNameSelection";
import { frontendLog } from "@/utils/frontendLog";
import { useRovingListNav } from "@/hooks/useRovingListNav";
import { useOsFileDrop } from "@/hooks/useOsFileDrop";
import { useLocalDirWatch } from "@/hooks/useLocalDirWatch";
import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";
import { FileBrowserPathBar } from "./FileBrowserPathBar";
import "./FileBrowser.css";

/**
 * Fixed row height in px, matching `.file-browser__row` in FileBrowser.css. The
 * list is virtualized (@tanstack/react-virtual) so only the visible window of
 * rows is mounted; a uniform height keeps the windowing math exact and cheap.
 */
const ROW_HEIGHT = 24;

/** Extra rows rendered above/below the viewport so fast scrolls stay smooth. */
const ROW_OVERSCAN = 8;

interface FileRowProps {
  entry: FileEntry;
  vscodeAvailable: boolean;
  onNavigate: (entry: FileEntry) => void;
  onContextAction: (entry: FileEntry, action: string) => void;
  onPaste: () => void;
  hasClipboard: boolean;
  isSelected: boolean;
  onRowClick: (entry: FileEntry, e: React.MouseEvent) => void;
  selectedCount: number;
  onMultiContextAction: (action: string) => void;
  onShareVia?: (path: string, protocol: "http" | "ftp" | "tftp") => void;
  /** Roving-tabindex value: 0 for the active row, -1 for the rest. */
  tabIndex: number;
  /** Ref callback so the parent can move focus to this row's button. */
  rowRef: (el: HTMLButtonElement | null) => void;
  /** When true, the row renders an inline rename input instead of the name. */
  isRenaming: boolean;
  /** Commit a rename to `newName` (parent validates and clears the edit). */
  onRenameSubmit: (entry: FileEntry, newName: string) => void;
  /** Abandon the in-progress rename. */
  onRenameCancel: () => void;
}

/**
 * Shared menu items for file/directory actions.
 * Renders identically in both the DropdownMenu (kebab) and ContextMenu (right-click)
 * by accepting the Radix Item/Separator components as props.
 */
export function FileMenuItems({
  entry,
  vscodeAvailable,
  onNavigate,
  onContextAction,
  onPaste,
  hasClipboard,
  onShareVia,
  Item,
  Separator,
  testIdPrefix,
}: {
  entry: FileEntry;
  vscodeAvailable: boolean;
  onNavigate: (entry: FileEntry) => void;
  onContextAction: (entry: FileEntry, action: string) => void;
  onPaste: () => void;
  hasClipboard: boolean;
  /** Only provided in local mode for directory entries. */
  onShareVia?: (path: string, protocol: "http" | "ftp" | "tftp") => void;
  Item: React.ElementType;
  Separator: React.ElementType;
  testIdPrefix: string;
}) {
  return (
    <>
      {entry.isDirectory && (
        <Item
          className="context-menu__item"
          onSelect={() => onNavigate(entry)}
          data-testid={`${testIdPrefix}-open`}
        >
          <FolderOpen size={14} /> Open
        </Item>
      )}
      {entry.isDirectory && onShareVia && (
        <>
          <Separator className="context-menu__separator" />
          <Item
            className="context-menu__item"
            onSelect={() => onShareVia(entry.path, "http")}
            data-testid={`${testIdPrefix}-share-http`}
          >
            <Globe size={14} /> Share via HTTP Server
          </Item>
          <Item
            className="context-menu__item"
            onSelect={() => onShareVia(entry.path, "ftp")}
            data-testid={`${testIdPrefix}-share-ftp`}
          >
            <Globe size={14} /> Share via FTP Server
          </Item>
          <Item
            className="context-menu__item"
            onSelect={() => onShareVia(entry.path, "tftp")}
            data-testid={`${testIdPrefix}-share-tftp`}
          >
            <Globe size={14} /> Share via TFTP Server
          </Item>
          <Separator className="context-menu__separator" />
        </>
      )}
      {!entry.isDirectory && (
        <Item
          className="context-menu__item"
          onSelect={() => onContextAction(entry, "download")}
          data-testid={`${testIdPrefix}-download`}
        >
          <Download size={14} /> Download
        </Item>
      )}
      {!entry.isDirectory && (
        <Item
          className="context-menu__item"
          onSelect={() => onContextAction(entry, "edit")}
          data-testid={`${testIdPrefix}-edit`}
        >
          <FileEdit size={14} /> Edit
        </Item>
      )}
      {!entry.isDirectory && vscodeAvailable && (
        <Item
          className="context-menu__item"
          onSelect={() => onContextAction(entry, "vscode")}
          data-testid={`${testIdPrefix}-vscode`}
        >
          <CodeXml size={14} /> Open in VS Code
        </Item>
      )}
      <Separator className="context-menu__separator" />
      <Item
        className="context-menu__item"
        onSelect={() => onContextAction(entry, "copy")}
        data-testid={`${testIdPrefix}-copy`}
      >
        <Copy size={14} /> Copy
      </Item>
      <Item
        className="context-menu__item"
        onSelect={() => onContextAction(entry, "cut")}
        data-testid={`${testIdPrefix}-cut`}
      >
        <Scissors size={14} /> Cut
      </Item>
      <Item
        className="context-menu__item"
        disabled={!hasClipboard}
        onSelect={onPaste}
        data-testid={`${testIdPrefix}-paste`}
      >
        <ClipboardPaste size={14} /> Paste
      </Item>
      <Item
        className="context-menu__item"
        onSelect={() => onContextAction(entry, "copyName")}
        data-testid={`${testIdPrefix}-copy-name`}
      >
        <Copy size={14} /> Copy Name
      </Item>
      <Item
        className="context-menu__item"
        onSelect={() => onContextAction(entry, "copyPath")}
        data-testid={`${testIdPrefix}-copy-path`}
      >
        <Copy size={14} /> Copy Path
      </Item>
      <Separator className="context-menu__separator" />
      <Item
        className="context-menu__item"
        onSelect={() => onContextAction(entry, "rename")}
        data-testid={`${testIdPrefix}-rename`}
      >
        <Pencil size={14} /> Rename
      </Item>
      <Item
        className="context-menu__item context-menu__item--danger"
        onSelect={() => onContextAction(entry, "delete")}
        data-testid={`${testIdPrefix}-delete`}
      >
        <Trash2 size={14} /> Delete
      </Item>
    </>
  );
}

/**
 * Context menu items shown when multiple files are selected.
 */
export function MultiSelectMenuItems({
  count,
  onAction,
  onPaste,
  hasClipboard,
  Item,
  Separator,
}: {
  count: number;
  onAction: (action: string) => void;
  onPaste: () => void;
  hasClipboard: boolean;
  Item: React.ElementType;
  Separator: React.ElementType;
}) {
  return (
    <>
      <Item
        className="context-menu__item"
        onSelect={() => onAction("copy")}
        data-testid="multi-select-copy"
      >
        <Copy size={14} /> Copy ({count} items)
      </Item>
      <Item
        className="context-menu__item"
        onSelect={() => onAction("cut")}
        data-testid="multi-select-cut"
      >
        <Scissors size={14} /> Cut ({count} items)
      </Item>
      <Item
        className="context-menu__item"
        disabled={!hasClipboard}
        onSelect={onPaste}
        data-testid="multi-select-paste"
      >
        <ClipboardPaste size={14} /> Paste
      </Item>
      <Separator className="context-menu__separator" />
      <Item
        className="context-menu__item context-menu__item--danger"
        onSelect={() => onAction("delete")}
        data-testid="multi-select-delete"
      >
        <Trash2 size={14} /> Delete ({count} items)
      </Item>
    </>
  );
}

/** A single clickable sort-column header. Toggles direction when re-clicked. */
function SortHeader({
  label,
  col,
  activeKey,
  direction,
  onToggle,
}: {
  label: string;
  col: FileSortKey;
  activeKey: FileSortKey;
  direction: SortDirection;
  onToggle: (col: FileSortKey) => void;
}) {
  const active = activeKey === col;
  return (
    <button
      type="button"
      className={`file-browser__col file-browser__col--${col}${
        active ? " file-browser__col--active" : ""
      }`}
      onClick={() => onToggle(col)}
      aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}
      data-testid={`file-browser-sort-${col}`}
    >
      <span>{label}</span>
      {active &&
        (direction === "asc" ? (
          <ChevronUp size={10} className="file-browser__col-caret" />
        ) : (
          <ChevronDown size={10} className="file-browser__col-caret" />
        ))}
    </button>
  );
}

/** The leading folder/file glyph shared by file rows and the rename editor. */
function FileEntryIcon({ entry }: { entry: FileEntry }) {
  // Symbolic links get a distinct badge-arrow glyph so they read differently
  // from a plain file/folder; a symlink-to-directory keeps the folder variant.
  if (entry.isSymlink) {
    return entry.isDirectory ? (
      <FolderSymlink
        size={16}
        className="file-browser__icon file-browser__icon--folder file-browser__icon--symlink"
      />
    ) : (
      <FileSymlink size={16} className="file-browser__icon file-browser__icon--symlink" />
    );
  }
  return entry.isDirectory ? (
    <Folder size={16} className="file-browser__icon file-browser__icon--folder" />
  ) : (
    <File size={16} className="file-browser__icon" />
  );
}

/**
 * Inline rename editor rendered in place of a file row. Mirrors the New File /
 * New Folder inline-input idiom: an uncontrolled input that commits on Enter
 * and cancels on Escape (the base name is pre-selected so the extension is
 * preserved).
 */
function RenameRow({
  entry,
  onSubmit,
  onCancel,
}: {
  entry: FileEntry;
  onSubmit: (entry: FileEntry, newName: string) => void;
  onCancel: () => void;
}) {
  return (
    <div className="file-browser__row-wrapper file-browser__row-wrapper--renaming">
      <div className="file-browser__row file-browser__row--renaming">
        <FileEntryIcon entry={entry} />
        <Input
          size="sm"
          defaultValue={entry.name}
          autoFocus
          spellCheck={false}
          data-testid="file-row-rename-input"
          aria-label={`Rename ${entry.name}`}
          onFocus={(e) => {
            // Pre-select the base name, preserving the extension.
            e.currentTarget.setSelectionRange(0, baseNameSelectionEnd(entry.name));
          }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onSubmit(entry, e.currentTarget.value);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
        />
      </div>
    </div>
  );
}

function FileRow({
  entry,
  vscodeAvailable,
  onNavigate,
  onContextAction,
  onPaste,
  hasClipboard,
  isSelected,
  onRowClick,
  selectedCount,
  onMultiContextAction,
  onShareVia,
  tabIndex,
  rowRef,
  isRenaming,
  onRenameSubmit,
  onRenameCancel,
}: FileRowProps) {
  const menuItemProps = {
    entry,
    vscodeAvailable,
    onNavigate,
    onContextAction,
    onPaste,
    hasClipboard,
    onShareVia,
  };

  const showMultiSelect = isSelected && selectedCount > 1;

  if (isRenaming) {
    return <RenameRow entry={entry} onSubmit={onRenameSubmit} onCancel={onRenameCancel} />;
  }

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          className={`file-browser__row-wrapper${isSelected ? " file-browser__row-wrapper--selected" : ""}`}
        >
          <button
            ref={rowRef}
            className="file-browser__row"
            tabIndex={tabIndex}
            data-testid={`file-row-${entry.name}`}
            onClick={(e) => onRowClick(entry, e)}
            onDoubleClick={() => {
              // Directories and symlinks are followed; other files open for edit.
              if (entry.isDirectory || entry.isSymlink) {
                onNavigate(entry);
              } else {
                onContextAction(entry, "edit");
              }
            }}
          >
            <FileEntryIcon entry={entry} />
            <span
              className="file-browser__name"
              title={
                entry.isSymlink
                  ? entry.symlinkTarget
                    ? `Symbolic link → ${entry.symlinkTarget}`
                    : "Symbolic link"
                  : undefined
              }
            >
              {entry.name}
            </span>
            {entry.isSymlink && entry.symlinkTarget && (
              <span
                className="file-browser__symlink-target"
                title={`Symbolic link → ${entry.symlinkTarget}`}
              >
                → {entry.symlinkTarget}
              </span>
            )}
            {entry.modified && (
              <span className="file-browser__modified">{formatRelativeTime(entry.modified)}</span>
            )}
            {!entry.isDirectory && (
              <span className="file-browser__size">{formatBytes(entry.size)}</span>
            )}
            {entry.permissions && (
              <span className="file-browser__permissions">{entry.permissions}</span>
            )}
          </button>
          <div className="file-browser__row-menu">
            <DropdownMenu.Root>
              <Tooltip content="Actions" side="top">
                <DropdownMenu.Trigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="file-browser__menu-reveal"
                    icon={<MoreHorizontal size={14} />}
                    aria-label="File actions"
                    data-testid={`file-row-menu-${entry.name}`}
                  />
                </DropdownMenu.Trigger>
              </Tooltip>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="context-menu__content" align="end">
                  <FileMenuItems
                    {...menuItemProps}
                    Item={DropdownMenu.Item}
                    Separator={DropdownMenu.Separator}
                    testIdPrefix="file-menu"
                  />
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="context-menu__content">
          {showMultiSelect ? (
            <MultiSelectMenuItems
              count={selectedCount}
              onAction={onMultiContextAction}
              onPaste={onPaste}
              hasClipboard={hasClipboard}
              Item={ContextMenu.Item}
              Separator={ContextMenu.Separator}
            />
          ) : (
            <FileMenuItems
              {...menuItemProps}
              Item={ContextMenu.Item}
              Separator={ContextMenu.Separator}
              testIdPrefix="context-file"
            />
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/**
 * Sync file browser mode and content based on the active terminal tab.
 */
function useFileBrowserSync() {
  const tabCwds = useAppStore((s) => s.tabCwds);
  const sidebarView = useAppStore((s) => s.sidebarView);
  const setFileBrowserMode = useAppStore((s) => s.setFileBrowserMode);
  const navigateLocal = useAppStore((s) => s.navigateLocal);
  const navigateSftp = useAppStore((s) => s.navigateSftp);
  const navigateSession = useAppStore((s) => s.navigateSession);
  const setSessionFileBrowserId = useAppStore((s) => s.setSessionFileBrowserId);
  const sftpSessionId = useAppStore((s) => s.sftpSessionId);
  const sessionFileBrowserId = useAppStore((s) => s.sessionFileBrowserId);
  const localCurrentPath = useAppStore((s) => s.localCurrentPath);
  const sftpCurrentPath = useAppStore((s) => s.currentPath);
  const sessionCurrentPath = useAppStore((s) => s.sessionCurrentPath);
  const { remoteAgents } = useProjectedAgents();
  const fileBrowserMode = useAppStore((s) => s.fileBrowserMode);
  const globalFileBrowserEnabled = useProjectedSettings().fileBrowserEnabled;

  // Derive mode from active tab
  const activeTab = useAppStore((s) => getActiveTab(s));
  const activeTabId = activeTab?.id ?? null;
  const activeTabConnectionType = activeTab?.connectionType ?? null;
  const activeTabContentType = activeTab?.contentType ?? null;
  const activeTabConfig = activeTab?.config ?? undefined;

  const connectionTypes = useAppStore((s) => s.connectionTypes);

  // Determine if the active tab's connection type supports file browsing
  const typeSupportsFileBrowser = (typeId: string, types: ConnectionTypeInfo[]): boolean => {
    const info = types.find((ct) => ct.typeId === typeId);
    return info?.capabilities.fileBrowser ?? false;
  };

  const fileBrowserEnabled =
    activeTabConnectionType && typeSupportsFileBrowser(activeTabConnectionType, connectionTypes)
      ? resolveFeatureEnabled(activeTabConfig, "enableFileBrowser", globalFileBrowserEnabled)
      : activeTabConnectionType === "local";

  const activeTabEditorMeta = activeTab?.editorMeta ?? null;

  // Extract the WSL distro name (if any) from the active tab's shell type
  const activeTabShellType =
    activeTab?.config.type === "local"
      ? (((activeTab.config.config.shell ?? activeTab.config.config.shellType) as ShellType) ??
        null)
      : null;
  const wslDistro =
    activeTab?.config.type === "wsl"
      ? ((activeTab.config.config.distribution as string) ?? null)
      : activeTabShellType
        ? getWslDistroName(activeTabShellType)
        : null;

  useEffect(() => {
    if (!activeTab || activeTabContentType === "settings") {
      setFileBrowserMode("none");
      return;
    }
    if (activeTabContentType === "editor") {
      // Editor tabs: derive mode from the transport the tab was opened with.
      // A session-backed tab must not fall into "sftp" mode — there is no
      // SftpManager session behind it, so the browser would show nothing. (#1557)
      if (activeTabEditorMeta?.sessionBrowser) {
        setSessionFileBrowserId(activeTabEditorMeta.sessionBrowser.sessionId);
        setFileBrowserMode("session");
      } else if (activeTabEditorMeta?.isRemote) {
        setFileBrowserMode("sftp");
      } else {
        setFileBrowserMode("local");
      }
      return;
    }
    if (activeTabConnectionType === "local" || activeTabConnectionType === "wsl") {
      setFileBrowserMode("local");
    } else if (activeTabConnectionType === "remote-session") {
      // Remote agent sessions: check if the agent's connection type supports file browsing
      const cfg = activeTab.config.config as { agentId?: string; sessionType?: string };
      const agentId = cfg.agentId;
      const sessionType = cfg.sessionType ?? "local";
      if (agentId) {
        const agent = remoteAgents.find((a) => a.id === agentId);
        const agentConnectionTypes = agent?.capabilities?.connectionTypes ?? [];
        const agentTypeInfo = agentConnectionTypes.find(
          (ct: ConnectionTypeInfo) => ct.typeId === sessionType
        );
        const agentSupportsFileBrowser = agentTypeInfo?.capabilities?.fileBrowser ?? false;
        if (agentSupportsFileBrowser && globalFileBrowserEnabled) {
          setSessionFileBrowserId(activeTab.sessionId);
          setFileBrowserMode("session");
        } else {
          setSessionFileBrowserId(null);
          setFileBrowserMode("none");
        }
      } else {
        setFileBrowserMode("none");
      }
    } else if (
      activeTabConnectionType &&
      typeSupportsFileBrowser(activeTabConnectionType, connectionTypes)
    ) {
      if (!fileBrowserEnabled) {
        setSessionFileBrowserId(null);
        setFileBrowserMode("none");
      } else if (activeTab.sessionId) {
        // Every file-browser-capable type dispatches through the session layer:
        // SessionManager keys sessions by id and routes file ops via
        // ConnectionType::file_browser(), so this works for any backend that
        // implements the trait (#1335). Since the SFTP convergence (#2421) this
        // includes SSH — its SFTP-backed session drives the dedicated transfer
        // channel + VS Code remote open through useSessionFileSystem, retiring the
        // separate SftpManager/sftp_* browser path (the sftpSessionId model is
        // removed in #2422).
        setSessionFileBrowserId(activeTab.sessionId);
        setFileBrowserMode("session");
      } else {
        // Session not established yet (still connecting) — this effect re-runs
        // once the tab receives its session id.
        setSessionFileBrowserId(null);
        setFileBrowserMode("none");
      }
    } else {
      setFileBrowserMode("none");
    }
  }, [
    fileBrowserEnabled,
    activeTab,
    activeTabId,
    activeTabConnectionType,
    activeTabContentType,
    activeTabEditorMeta,
    setFileBrowserMode,
    setSessionFileBrowserId,
    connectionTypes,
    remoteAgents,
    globalFileBrowserEnabled,
  ]);

  // Auto-navigate on tab switch or CWD change
  const cwd = activeTabId ? tabCwds[activeTabId] : undefined;
  useEffect(() => {
    if (sidebarView !== "files") return;

    // Editor tabs: navigate to the file's parent directory
    if (activeTabContentType === "editor" && activeTabEditorMeta) {
      const parentDir = activeTabEditorMeta.filePath.replace(/\/[^/]+$/, "") || "/";
      if (activeTabEditorMeta.isRemote && sftpSessionId) {
        navigateSftp(parentDir);
      } else if (!activeTabEditorMeta.isRemote) {
        navigateLocal(parentDir);
      }
      return;
    }

    const currentMode = useAppStore.getState().fileBrowserMode;
    if (currentMode === "local") {
      if (cwd) {
        navigateLocal(wslDistro ? wslToWindowsPath(cwd, wslDistro) : cwd);
      } else if (wslDistro) {
        navigateLocal(wslToWindowsPath("/", wslDistro));
      } else {
        getHomeDir()
          .then((home) => navigateLocal(home))
          .catch(() => navigateLocal("/"));
      }
    } else if (currentMode === "sftp" && sftpSessionId && cwd) {
      navigateSftp(cwd);
    } else if (currentMode === "session" && sessionFileBrowserId && cwd) {
      navigateSession(sessionFileBrowserId, cwd);
    }
  }, [
    activeTabId,
    cwd,
    wslDistro,
    sidebarView,
    activeTabContentType,
    activeTabEditorMeta,
    navigateLocal,
    navigateSftp,
    navigateSession,
    sftpSessionId,
    sessionFileBrowserId,
  ]);

  // Auto-navigate when entering local mode with no entries loaded yet.
  // Shells that don't send OSC 7 (e.g., bash) leave cwd undefined,
  // so we fall back to the user's home directory (or WSL root for WSL tabs).
  useEffect(() => {
    if (fileBrowserMode !== "local") return;
    const { localFileEntries } = useAppStore.getState();
    if (localFileEntries.length > 0) return; // Already loaded

    if (cwd) {
      navigateLocal(wslDistro ? wslToWindowsPath(cwd, wslDistro) : cwd);
    } else if (wslDistro) {
      navigateLocal(wslToWindowsPath("/", wslDistro));
    } else {
      getHomeDir()
        .then((home) => navigateLocal(home))
        .catch(() => navigateLocal("/"));
    }
  }, [fileBrowserMode, navigateLocal, cwd, wslDistro]);

  // Auto-navigate when entering session mode with no entries loaded yet.
  useEffect(() => {
    if (fileBrowserMode !== "session" || !sessionFileBrowserId) return;
    const { sessionFileEntries } = useAppStore.getState();
    if (sessionFileEntries.length > 0) return; // Already loaded
    // Fall back to "~" so the agent resolves the home directory instead of "/".
    navigateSession(sessionFileBrowserId, cwd ?? "~");
  }, [fileBrowserMode, sessionFileBrowserId, navigateSession, cwd]);

  // (Removed in #2421) The SSH-specific SFTP auto-connect effect that opened a
  // separate SftpManager session when a file-browser-capable tab entered "sftp"
  // mode. SSH now browses through the session layer (mode "session"), so no tab
  // enters "sftp" mode and the standalone connect is dead. The legacy sftp store
  // model itself is retired in #2422.

  // Callback to jump the file browser back to the terminal's current CWD.
  const navigateToCwd = useCallback(() => {
    if (!cwd) return;
    const currentMode = useAppStore.getState().fileBrowserMode;
    if (currentMode === "local") {
      navigateLocal(wslDistro ? wslToWindowsPath(cwd, wslDistro) : cwd);
    } else if (currentMode === "sftp" && sftpSessionId) {
      navigateSftp(cwd);
    }
  }, [cwd, wslDistro, navigateLocal, navigateSftp, sftpSessionId]);

  // Callback to send "cd <current-file-browser-path>" to the active terminal.
  const cdToCurrentPath = useCallback(async () => {
    const sessionId = activeTab?.sessionId ?? null;
    if (!sessionId) return;
    const { fileBrowserMode } = useAppStore.getState();

    let path: string;
    if (fileBrowserMode === "local") {
      // Convert Windows-style WSL paths back to Linux paths for the WSL terminal
      path = wslDistro ? windowsToWslPath(localCurrentPath) : localCurrentPath;
    } else if (fileBrowserMode === "sftp") {
      path = sftpCurrentPath;
    } else if (fileBrowserMode === "session") {
      path = sessionCurrentPath;
    } else {
      return;
    }

    // Build the cd command with appropriate quoting
    const cdCmd = /^[A-Za-z]:/.test(path)
      ? `cd "${path.replace(/"/g, '\\"')}"` // Windows path: double quotes
      : `cd -- '${path.replace(/'/g, "'\\''")}'`; // Unix path: single quotes
    await sendInput(sessionId, cdCmd + "\n");
  }, [activeTab?.sessionId, localCurrentPath, sftpCurrentPath, sessionCurrentPath, wslDistro]);

  const canCd =
    !!activeTab?.sessionId && fileBrowserMode !== "none" && activeTab?.contentType !== "editor";

  return { navigateToCwd, hasCwd: !!cwd, cdToCurrentPath, canCd };
}

export function FileBrowser() {
  const { navigateToCwd, hasCwd, cdToCurrentPath, canCd } = useFileBrowserSync();

  const {
    fileEntries,
    currentPath,
    isConnected,
    isLoading,
    error,
    navigateTo,
    navigateUp,
    refresh,
    downloadFile,
    uploadFile,
    uploadFileFromPath,
    createDirectory,
    createFile,
    deleteEntry,
    renameEntry,
    openInVscode,
    copyEntry,
    cutEntry,
    pasteEntry,
    mode,
  } = useFileBrowser();

  const containerRef = useRef<HTMLDivElement>(null);

  const handleOsDrop = useCallback(
    async (paths: string[]) => {
      for (const path of paths) {
        await uploadFileFromPath(path);
      }
    },
    [uploadFileFromPath]
  );

  const { isDragOver } = useOsFileDrop(containerRef, handleOsDrop);

  // Auto-refresh the local listing when its directory changes on disk under
  // another process (#1626). Event-driven via the backend directory watcher;
  // local transport only (remote external-change detection is #1627). The
  // toolbar Refresh button stays as a manual backstop.
  useLocalDirWatch(mode === "local", mode === "local" ? currentPath : null, refresh);

  const disconnectSftp = useAppStore((s) => s.disconnectSftp);
  const retrySftp = useAppStore((s) => s.retrySftp);
  const dismissSftpError = useAppStore((s) => s.dismissSftpError);
  // Explicit SFTP lifecycle status (audit gap A1) — used to pick the SFTP
  // placeholder label without inferring it from isConnected + isLoading.
  const sftpStatus = useAppStore((s) => s.sftpStatus);
  // In-flight SFTP transfers (#1247); the footer shows those owned by the
  // active browser session, and Cancel fires sftp_cancel_transfer.
  const transfers = useAppStore((s) => s.transfers);
  const cancelTransfer = useAppStore((s) => s.cancelTransfer);
  const vscodeAvailable = useAppStore((s) => s.vscodeAvailable);
  // Render cut (#2228): the copy-cut clipboard is sourced from the projected
  // client-scoped file-browser region (mirror-gated, falls back to appStore).
  const fileClipboard = useProjectedFileBrowsers().clipboard;
  const quickShareServer = useAppStore((s) => s.quickShareServer);
  const setSidebarView = useAppStore((s) => s.setSidebarView);
  const [newDirName, setNewDirName] = useState<string | null>(null);
  const [newFileName, setNewFileName] = useState<string | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [lastClickedPath, setLastClickedPath] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{
    message: string;
    onConfirm: () => void;
  } | null>(null);
  const [sort, setSort] = useState<{ key: FileSortKey; dir: SortDirection }>({
    key: "name",
    dir: "asc",
  });
  const [filterQuery, setFilterQuery] = useState("");

  // Sorted, then filtered — the single source of order for both the rendered
  // rows and keyboard navigation, so the two never disagree. Kept as two memos
  // so filter keystrokes don't re-sort the whole directory.
  const sortedEntries = useMemo(
    () => sortEntries(fileEntries, sort.key, sort.dir),
    [fileEntries, sort.key, sort.dir]
  );
  const displayEntries = useMemo(
    () => filterEntries(sortedEntries, filterQuery),
    [sortedEntries, filterQuery]
  );

  // Scroll container for the row list; the virtualizer measures and scrolls it.
  const listRef = useRef<HTMLDivElement>(null);

  // Only the visible window of rows (+overscan) is mounted, so a directory with
  // thousands of entries no longer renders thousands of DOM nodes. Uniform row
  // height (ROW_HEIGHT) keeps the layout math exact; the scroll + scrollbar stay
  // on `.file-browser__list`, so the global scrollbar styling is reused as-is.
  const rowVirtualizer = useVirtualizer({
    count: displayEntries.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: ROW_OVERSCAN,
    // Key rows by path so selection/focus survive scroll-driven remounts.
    getItemKey: (index) => displayEntries[index]?.path ?? index,
    // Reset the `isScrolling` flag from the native `scrollend` event where the
    // platform supports it, rather than the default 150ms debounce. The debounce
    // arms a `setTimeout` on every scroll that react-virtual's cleanup never
    // clears, so unmounting within that window leaves the timer to later fire a
    // state update on a torn-down tree — harmless in the running app, but under
    // jsdom (once the environment is disposed) it surfaces as an unhandled
    // "window is not defined" that fails the whole test run. Where `scrollend`
    // is unavailable react-virtual transparently falls back to the debounce, so
    // this is a safe, strictly-better opt-in.
    useScrollendEvent: true,
  });

  // Roving-tabindex keyboard navigation over the displayed rows. The hook owns
  // the active focus index, the type-ahead buffer, and the per-row ref wiring;
  // selection/navigation semantics are supplied below via makeKeyDownHandler.
  // The scroll callback lets the hook mount an off-screen focus target (via the
  // virtualizer) before focusing it — essential once rows are windowed.
  const { activeIndex, setActiveIndex, getRowRef, reset, makeKeyDownHandler } = useRovingListNav<
    FileEntry,
    HTMLButtonElement
  >(displayEntries, (e) => e.name, {
    onScrollToIndex: (index) => rowVirtualizer.scrollToIndex(index),
  });

  // Listen for VS Code edit-complete events (remote file re-upload)
  useEffect(() => {
    let cleanup: (() => void) | null = null;
    onVscodeEditComplete((remotePath, success, err) => {
      const name = remotePath.split("/").pop() || remotePath;
      if (success) {
        toast.success(`Saved "${name}" from VS Code`);
        refresh();
      } else {
        frontendLog("file_browser", `VS Code edit failed for ${remotePath}: ${err}`);
        toast.error(`Failed to save "${name}" from VS Code: ${err}`);
      }
    }).then((fn) => {
      cleanup = fn;
    });
    return () => {
      if (cleanup) cleanup();
    };
  }, [refresh]);

  const clearSelection = useCallback(() => {
    setSelectedPaths(new Set());
    setLastClickedPath(null);
  }, []);

  // Full reset when the listing changes underfoot (navigation): drop the
  // selection, return roving focus to the top, and clear any active filter.
  const resetNavState = useCallback(() => {
    clearSelection();
    reset();
    setFilterQuery("");
  }, [clearSelection, reset]);

  const handleNavigatePath = useCallback(
    (path: string) => {
      resetNavState();
      navigateTo(path);
    },
    [navigateTo, resetNavState]
  );

  const handleNavigate = useCallback(
    (entry: FileEntry) => {
      // A real directory (including a symlink-to-dir, which reports
      // isDirectory) is listed by its own path. A symlink whose target type is
      // unknown (e.g. FTP) is followed via its resolved target path.
      if (entry.isDirectory) {
        handleNavigatePath(entry.path);
      } else if (entry.isSymlink) {
        handleNavigatePath(resolveSymlinkTarget(entry));
      }
    },
    [handleNavigatePath]
  );

  const handleNavigateUp = useCallback(() => {
    resetNavState();
    navigateUp();
  }, [navigateUp, resetNavState]);

  const toggleSort = useCallback((key: FileSortKey) => {
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }
    );
  }, []);

  const sftpSessionId = useAppStore((s) => s.sftpSessionId);
  const sessionFileBrowserId = useAppStore((s) => s.sessionFileBrowserId);
  const activeTabConnectionType = useAppStore((s) => getActiveTab(s)?.connectionType ?? null);

  const handleContextAction = useCallback(
    (entry: FileEntry, action: string) => {
      switch (action) {
        case "edit":
          if (mode === "local" || mode === "sftp") {
            useAppStore
              .getState()
              .openEditorTab(
                entry.path,
                mode === "sftp",
                mode === "sftp" ? (sftpSessionId ?? undefined) : undefined,
                mode === "sftp" ? entry.permissions : undefined
              );
          } else if (mode === "session" && sessionFileBrowserId) {
            // Session-layer browsing (FTP, Docker, agent sessions): the editor
            // reads and writes through session_read_file / session_write_file
            // rather than an SftpManager session. (#1557)
            useAppStore.getState().openEditorTab(entry.path, true, undefined, entry.permissions, {
              sessionId: sessionFileBrowserId,
              connectionType: activeTabConnectionType ?? "remote-session",
            });
          }
          break;
        case "download":
          // downloadFile surfaces its own success/error toast (see useFileSystem).
          void downloadFile(entry.path, entry.name);
          break;
        case "vscode":
          openInVscode(entry.path).catch((err: unknown) => {
            frontendLog("file_browser", `Open in VS Code failed: ${err}`);
            toast.error(`Failed to open "${entry.name}" in VS Code: ${err}`);
          });
          break;
        case "copy":
          copyEntry([entry]);
          break;
        case "cut":
          cutEntry([entry]);
          break;
        case "copyName":
          writeClipboard(entry.name)
            .then(() => toast.success("Copied name"))
            .catch((err: unknown) => {
              frontendLog("file_browser", `Copy name failed: ${err}`);
              toast.error(`Failed to copy name: ${err}`);
            });
          break;
        case "copyPath":
          writeClipboard(entry.path)
            .then(() => toast.success("Copied path"))
            .catch((err: unknown) => {
              frontendLog("file_browser", `Copy path failed: ${err}`);
              toast.error(`Failed to copy path: ${err}`);
            });
          break;
        case "rename": {
          // Inline rename: the row renders an editable input (see FileRow).
          setRenamingPath(entry.path);
          break;
        }
        case "delete": {
          setDeleteConfirm({
            message: `Delete ${entry.isDirectory ? "directory" : "file"} "${entry.name}"?`,
            onConfirm: () => {
              deleteEntry(entry.path, entry.isDirectory)
                .then(() => toast.success(`Deleted "${entry.name}"`))
                .catch((err: unknown) => toast.error(`Failed to delete "${entry.name}": ${err}`));
            },
          });
          break;
        }
      }
    },
    [
      mode,
      sftpSessionId,
      sessionFileBrowserId,
      activeTabConnectionType,
      downloadFile,
      openInVscode,
      copyEntry,
      cutEntry,
      deleteEntry,
    ]
  );

  const handleRenameSubmit = useCallback(
    (entry: FileEntry, rawName: string) => {
      setRenamingPath(null);
      const newName = rawName.trim();
      if (!newName || newName === entry.name) return;
      renameEntry(entry.path, newName)
        .then(() => toast.success(`Renamed to "${newName}"`))
        .catch((err: unknown) => {
          frontendLog("file_browser", `Rename failed: ${err}`);
          toast.error(`Rename failed: ${err}`);
        });
    },
    [renameEntry]
  );

  const handleRenameCancel = useCallback(() => setRenamingPath(null), []);

  const handleShareVia = useCallback(
    (path: string, protocol: "http" | "ftp" | "tftp") => {
      quickShareServer(path, protocol);
      setSidebarView("services");
    },
    [quickShareServer, setSidebarView]
  );

  const handlePaste = useCallback(() => {
    // pasteEntry surfaces its own per-item success/error toast (see useFileSystem).
    void pasteEntry();
  }, [pasteEntry]);

  const handleRowClick = useCallback(
    (entry: FileEntry, e: React.MouseEvent) => {
      const index = displayEntries.findIndex((fe) => fe.path === entry.path);
      if (index >= 0) setActiveIndex(index);
      if (e.ctrlKey || e.metaKey) {
        // Toggle this entry's selection
        setSelectedPaths((prev) => {
          const next = new Set(prev);
          if (next.has(entry.path)) {
            next.delete(entry.path);
          } else {
            next.add(entry.path);
          }
          return next;
        });
        setLastClickedPath(entry.path);
      } else if (e.shiftKey && lastClickedPath) {
        // Range-select from lastClickedPath to this entry using the display order
        const paths = displayEntries.map((fe) => fe.path);
        const anchorIdx = paths.indexOf(lastClickedPath);
        const targetIdx = paths.indexOf(entry.path);
        if (anchorIdx >= 0 && targetIdx >= 0) {
          const [start, end] =
            anchorIdx < targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx];
          setSelectedPaths(new Set(paths.slice(start, end + 1)));
        }
      } else {
        // Plain click: select only this entry
        setSelectedPaths(new Set([entry.path]));
        setLastClickedPath(entry.path);
      }
    },
    [displayEntries, lastClickedPath, setActiveIndex]
  );

  // Wire the roving-nav keydown handler to this browser's selection and
  // navigation semantics. The hook owns focus movement and type-ahead; these
  // callbacks apply selection changes (range/single/all/clear) and route
  // Enter/F2/Backspace to the corresponding file-browser actions.
  const handleListKeyDown = useMemo(
    () =>
      makeKeyDownHandler({
        onActivate: (entry) => {
          if (entry.isDirectory || entry.isSymlink) handleNavigate(entry);
          else handleContextAction(entry, "edit");
        },
        onNavigateUp: handleNavigateUp,
        onRename: (entry) => setRenamingPath(entry.path),
        onSelectAll: () => {
          setSelectedPaths(new Set(displayEntries.map((fe) => fe.path)));
          if (displayEntries.length > 0) {
            setLastClickedPath(displayEntries[displayEntries.length - 1].path);
          }
        },
        onClearSelection: clearSelection,
        getAnchorIndex: () =>
          lastClickedPath ? displayEntries.findIndex((fe) => fe.path === lastClickedPath) : -1,
        onSelectRange: (start, end) =>
          setSelectedPaths(new Set(displayEntries.slice(start, end + 1).map((fe) => fe.path))),
        onSelectSingle: (entry) => {
          setSelectedPaths(new Set([entry.path]));
          setLastClickedPath(entry.path);
        },
      }),
    [
      makeKeyDownHandler,
      displayEntries,
      lastClickedPath,
      clearSelection,
      handleNavigate,
      handleNavigateUp,
      handleContextAction,
    ]
  );

  // Resolve the currently-selected entries only when a multi-action fires,
  // rather than filtering on every render.
  const handleMultiAction = useCallback(
    (action: string) => {
      const entries = displayEntries.filter((e) => selectedPaths.has(e.path));
      switch (action) {
        case "copy":
          copyEntry(entries);
          break;
        case "cut":
          cutEntry(entries);
          break;
        case "delete": {
          setDeleteConfirm({
            message: `Delete ${entries.length} items?`,
            onConfirm: () => {
              // Settle every delete independently so a partial failure never
              // hides which items were actually removed (#1394).
              void Promise.allSettled(entries.map((e) => deleteEntry(e.path, e.isDirectory))).then(
                (results) => {
                  const failed = entries.filter((_, i) => results[i].status === "rejected");
                  const deleted = entries.length - failed.length;
                  const noun = (n: number) => (n === 1 ? "item" : "items");
                  if (failed.length === 0) {
                    toast.success(`Deleted ${deleted} ${noun(deleted)}`);
                  } else {
                    const names = failed.map((e) => e.name).join(", ");
                    toast.error(
                      `Deleted ${deleted} ${noun(deleted)}, ${failed.length} failed: ${names}`
                    );
                  }
                }
              );
              setSelectedPaths(new Set());
              setLastClickedPath(null);
            },
          });
          break;
        }
      }
    },
    [displayEntries, selectedPaths, copyEntry, cutEntry, deleteEntry]
  );

  const handleCreateDir = useCallback(() => {
    if (newDirName && newDirName.trim()) {
      const name = newDirName.trim();
      createDirectory(name)
        .then(() => toast.success(`Created folder "${name}"`))
        .catch((err: unknown) => {
          frontendLog("file_browser", `Create directory failed: ${err}`);
          toast.error(`Failed to create folder "${name}": ${err}`);
        });
      setNewDirName(null);
    }
  }, [newDirName, createDirectory]);

  const handleCreateFile = useCallback(() => {
    if (newFileName && newFileName.trim()) {
      const name = newFileName.trim();
      createFile(name)
        .then(() => toast.success(`Created file "${name}"`))
        .catch((err: unknown) => {
          frontendLog("file_browser", `Create file failed: ${err}`);
          toast.error(`Failed to create file "${name}": ${err}`);
        });
      setNewFileName(null);
    }
  }, [newFileName, createFile]);

  // "none" mode — show placeholder
  if (mode === "none") {
    return (
      <div className="file-browser">
        <div className="file-browser__placeholder" data-testid="file-browser-placeholder">
          <MonitorOff size={32} />
          <span>No filesystem available for this connection type</span>
        </div>
      </div>
    );
  }

  // Session mode — show loading/error state when not yet connected
  if (mode === "session" && !isConnected) {
    return (
      <div className="file-browser">
        <div className="file-browser__placeholder" data-testid="file-browser-session-connecting">
          {isLoading ? (
            <>
              <Loader2 size={20} className="file-browser__spinner" />
              <span>Loading files...</span>
            </>
          ) : error ? (
            <>
              <AlertCircle size={20} />
              <span>{error}</span>
            </>
          ) : (
            <span>Waiting for session...</span>
          )}
        </div>
      </div>
    );
  }

  // SFTP not yet connected — show loading/error state
  if (mode === "sftp" && !isConnected) {
    return (
      <div className="file-browser">
        <div className="file-browser__placeholder" data-testid="file-browser-sftp-connecting">
          {sftpStatus === "connecting" ? (
            <>
              <Loader2 size={20} className="file-browser__spinner" />
              <span>Connecting SFTP...</span>
            </>
          ) : error ? (
            <>
              <AlertCircle size={20} />
              <span>{error}</span>
              {/* Recovery controls for a failed connect (audit gap S1). */}
              <div className="file-browser__error-actions">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<RefreshCw size={14} />}
                  onClick={() => retrySftp()}
                  data-testid="file-browser-sftp-retry"
                >
                  Retry
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<X size={14} />}
                  onClick={dismissSftpError}
                  data-testid="file-browser-sftp-dismiss"
                >
                  Dismiss
                </Button>
              </div>
            </>
          ) : (
            <span>Waiting for SFTP connection...</span>
          )}
        </div>
      </div>
    );
  }

  // In-flight transfers owned by the session this browser is showing (#1247).
  // Only these belong in the footer; other sessions' transfers live in the Open
  // Connections panel. The list above stays live regardless. Both transport
  // shapes register on the `transfers` map keyed by session id: the legacy SFTP
  // browser by `sftpSessionId`, and — since the convergence (#2421) — an
  // SFTP-backed session browser (SSH) by its `sessionFileBrowserId`. A byte-based
  // session backend (Docker / FTP / agent) registers no transfers, so its footer
  // stays empty as before.
  const footerSessionId = sftpSessionId ?? sessionFileBrowserId;
  const activeTransfers = footerSessionId
    ? Object.values(transfers).filter((t) => t.sessionId === footerSessionId)
    : [];

  const handleCancelTransfer = async (transferId: string) => {
    try {
      await cancelTransfer(transferId);
      toast.success("Transfer cancelled");
    } catch (err) {
      toast.error(`Failed to cancel transfer: ${err}`);
    }
  };

  return (
    <div
      className={`file-browser${isDragOver ? " file-browser--drag-over" : ""}`}
      ref={containerRef}
    >
      {isDragOver && (
        <div className="file-browser__drag-overlay">
          <Upload size={24} />
          <span>{mode === "local" ? "Drop to copy here" : "Drop to upload"}</span>
        </div>
      )}
      <div className="file-browser__toolbar">
        <FileBrowserPathBar currentPath={currentPath} onNavigate={handleNavigatePath} />
        <div className="file-browser__actions">
          <Tooltip content="Go Up" side="top">
            <Button
              variant="ghost"
              size="sm"
              icon={<ArrowUp size={14} />}
              onClick={handleNavigateUp}
              disabled={currentPath === "/" || /^[A-Za-z]:\/?$/.test(currentPath)}
              aria-label="Go up one directory"
              data-testid="file-browser-up"
            />
          </Tooltip>
          <Tooltip content="Go to Terminal CWD" side="top">
            <Button
              variant="ghost"
              size="sm"
              icon={<FolderSync size={14} />}
              onClick={navigateToCwd}
              disabled={!hasCwd}
              aria-label="Go to terminal working directory"
              data-testid="file-browser-go-to-cwd"
            />
          </Tooltip>
          <Tooltip
            content={canCd ? `cd to ${currentPath}` : "cd here (no active terminal)"}
            side="top"
          >
            <Button
              variant="ghost"
              size="sm"
              icon={<Terminal size={14} />}
              onClick={cdToCurrentPath}
              disabled={!canCd}
              aria-label="Send cd for current path to terminal"
              data-testid="file-browser-cd-here"
            />
          </Tooltip>
          <Tooltip content="Refresh" side="top">
            <Button
              variant="ghost"
              size="sm"
              icon={<RefreshCw size={14} className={isLoading ? "file-browser__spinner" : ""} />}
              onClick={refresh}
              aria-label="Refresh file list"
              data-testid="file-browser-refresh"
            />
          </Tooltip>
          {(mode === "sftp" || mode === "session") && (
            <Tooltip content="Upload File" side="top">
              <Button
                variant="ghost"
                size="sm"
                icon={<Upload size={14} />}
                onClick={uploadFile}
                aria-label="Upload file"
                data-testid="file-browser-upload"
              />
            </Tooltip>
          )}
          <Tooltip
            content={
              fileClipboard
                ? fileClipboard.entries.length === 1
                  ? `Paste "${fileClipboard.entries[0].name}" (${fileClipboard.operation})`
                  : `Paste ${fileClipboard.entries.length} items (${fileClipboard.operation})`
                : "Paste"
            }
            side="top"
          >
            <Button
              variant="ghost"
              size="sm"
              icon={<ClipboardPaste size={14} />}
              onClick={handlePaste}
              disabled={!fileClipboard}
              aria-label="Paste"
              data-testid="file-browser-paste"
            />
          </Tooltip>
          <Tooltip content="New File" side="top">
            <Button
              variant="ghost"
              size="sm"
              icon={<FilePlus size={14} />}
              onClick={() => setNewFileName("")}
              aria-label="New file"
              data-testid="file-browser-new-file"
            />
          </Tooltip>
          <Tooltip content="New Folder" side="top">
            <Button
              variant="ghost"
              size="sm"
              icon={<FolderPlus size={14} />}
              onClick={() => setNewDirName("")}
              aria-label="New folder"
              data-testid="file-browser-new-folder"
            />
          </Tooltip>
          {mode === "sftp" && (
            <Tooltip content="Disconnect" side="top">
              <Button
                variant="ghost"
                size="sm"
                icon={<Unplug size={14} />}
                onClick={disconnectSftp}
                aria-label="Disconnect SFTP"
                data-testid="file-browser-disconnect"
              />
            </Tooltip>
          )}
        </div>
      </div>

      <div className="file-browser__subbar">
        <div className="file-browser__filter">
          <Search size={12} className="file-browser__filter-icon" />
          <Input
            inline
            className="file-browser__filter-input"
            placeholder="Filter"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            aria-label="Filter files"
            data-testid="file-browser-filter"
          />
          {filterQuery && (
            <Tooltip content="Clear filter" side="top">
              <Button
                variant="ghost"
                size="sm"
                icon={<X size={12} />}
                onClick={() => setFilterQuery("")}
                aria-label="Clear filter"
                data-testid="file-browser-filter-clear"
              />
            </Tooltip>
          )}
        </div>
        <div className="file-browser__columns">
          <SortHeader
            label="Name"
            col="name"
            activeKey={sort.key}
            direction={sort.dir}
            onToggle={toggleSort}
          />
          <SortHeader
            label="Modified"
            col="modified"
            activeKey={sort.key}
            direction={sort.dir}
            onToggle={toggleSort}
          />
          <SortHeader
            label="Size"
            col="size"
            activeKey={sort.key}
            direction={sort.dir}
            onToggle={toggleSort}
          />
        </div>
      </div>

      {error && (
        <div className="file-browser__error">
          <AlertCircle size={14} />
          <span>{error}</span>
        </div>
      )}

      {newFileName !== null && (
        <div className="file-browser__new-dir">
          <Input
            size="sm"
            placeholder="File name"
            value={newFileName}
            onChange={(e) => setNewFileName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreateFile();
              if (e.key === "Escape") setNewFileName(null);
            }}
            autoFocus
            data-testid="file-browser-new-file-input"
          />
          <Tooltip content="Create" side="top">
            <Button
              variant="ghost"
              size="sm"
              icon={<FilePlus size={14} />}
              onClick={handleCreateFile}
              aria-label="Create file"
              data-testid="file-browser-new-file-confirm"
            />
          </Tooltip>
        </div>
      )}

      {newDirName !== null && (
        <div className="file-browser__new-dir">
          <Input
            size="sm"
            placeholder="Folder name"
            value={newDirName}
            onChange={(e) => setNewDirName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreateDir();
              if (e.key === "Escape") setNewDirName(null);
            }}
            autoFocus
            data-testid="file-browser-new-folder-input"
          />
          <Tooltip content="Create" side="top">
            <Button
              variant="ghost"
              size="sm"
              icon={<FolderPlus size={14} />}
              onClick={handleCreateDir}
              aria-label="Create folder"
              data-testid="file-browser-new-folder-confirm"
            />
          </Tooltip>
        </div>
      )}

      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          {isLoading && fileEntries.length === 0 ? (
            <div className="file-browser__loading">
              <Loader2 size={20} className="file-browser__spinner" />
              <span>Loading...</span>
            </div>
          ) : (
            <div
              ref={listRef}
              className="file-browser__list"
              data-testid="file-browser-list"
              onKeyDown={handleListKeyDown}
              onClick={(e) => {
                // Clicking empty space (the list itself or the virtual spacer,
                // never a row) clears the selection.
                const target = e.target as HTMLElement;
                if (
                  target === e.currentTarget ||
                  target.classList.contains("file-browser__list-inner")
                ) {
                  clearSelection();
                }
              }}
            >
              {displayEntries.length === 0 ? (
                <div className="file-browser__empty">
                  {filterQuery ? "No files match the filter" : "This folder is empty"}
                </div>
              ) : (
                <div
                  className="file-browser__list-inner"
                  style={{ height: rowVirtualizer.getTotalSize() }}
                >
                  {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                    const index = virtualRow.index;
                    const entry = displayEntries[index];
                    if (!entry) return null;
                    return (
                      <div
                        key={virtualRow.key}
                        className="file-browser__virtual-row"
                        style={{ transform: `translateY(${virtualRow.start}px)` }}
                      >
                        <FileRow
                          entry={entry}
                          vscodeAvailable={vscodeAvailable}
                          onNavigate={handleNavigate}
                          onContextAction={handleContextAction}
                          onPaste={handlePaste}
                          hasClipboard={fileClipboard !== null}
                          isSelected={selectedPaths.has(entry.path)}
                          onRowClick={handleRowClick}
                          selectedCount={selectedPaths.size}
                          onMultiContextAction={handleMultiAction}
                          onShareVia={mode === "local" ? handleShareVia : undefined}
                          tabIndex={index === activeIndex ? 0 : -1}
                          rowRef={getRowRef(index)}
                          isRenaming={renamingPath === entry.path}
                          onRenameSubmit={handleRenameSubmit}
                          onRenameCancel={handleRenameCancel}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className="context-menu__content">
            <ContextMenu.Item
              className="context-menu__item"
              disabled={!fileClipboard}
              onSelect={handlePaste}
              data-testid="context-bg-paste"
            >
              <ClipboardPaste size={14} /> Paste
            </ContextMenu.Item>
            <ContextMenu.Separator className="context-menu__separator" />
            <ContextMenu.Item
              className="context-menu__item"
              onSelect={() => setNewFileName("")}
              data-testid="context-bg-new-file"
            >
              <FilePlus size={14} /> New File
            </ContextMenu.Item>
            <ContextMenu.Item
              className="context-menu__item"
              onSelect={() => setNewDirName("")}
              data-testid="context-bg-new-folder"
            >
              <FolderPlus size={14} /> New Folder
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {(mode === "local" || selectedPaths.size > 0) && (
        <div className="file-browser__statusbar">
          {mode === "local" && (
            <span className="file-browser__drop-hint" data-testid="file-browser-drop-hint">
              <Upload size={11} /> Drop files here
            </span>
          )}
          {selectedPaths.size > 0 && (
            <span
              className="file-browser__selected-count"
              data-testid="file-browser-selected-count"
            >
              {selectedPaths.size} selected
            </span>
          )}
        </div>
      )}
      <ConfirmDeleteDialog
        open={deleteConfirm !== null}
        message={deleteConfirm?.message ?? ""}
        onConfirm={() => {
          deleteConfirm?.onConfirm();
          setDeleteConfirm(null);
        }}
        onCancel={() => setDeleteConfirm(null)}
      />
      {activeTransfers.length > 0 && (
        <div className="file-browser__transfers" data-testid="file-browser-transfers">
          {activeTransfers.map((t) => {
            const indeterminate = t.total <= 0;
            const pct = indeterminate ? 0 : Math.round((t.transferred / t.total) * 100);
            const verb = t.direction === "download" ? "Downloading" : "Uploading";
            return (
              <div
                key={t.transferId}
                className="file-browser__transfer"
                data-testid="file-browser-transfer"
              >
                <div className="file-browser__transfer-head">
                  {t.direction === "download" ? <Download size={12} /> : <Upload size={12} />}
                  <span className="file-browser__transfer-name" title={t.fileName}>
                    {t.fileName}
                  </span>
                  <span className="file-browser__transfer-pct">
                    {indeterminate ? formatBytes(t.transferred) : `${pct}%`}
                  </span>
                  <Tooltip content="Cancel transfer" side="top">
                    <Button
                      variant="danger"
                      size="sm"
                      icon={<Ban size={12} />}
                      className="file-browser__transfer-cancel"
                      onClick={() => handleCancelTransfer(t.transferId)}
                      aria-label={`Cancel transfer of ${t.fileName}`}
                    />
                  </Tooltip>
                </div>
                <Progress
                  value={t.transferred}
                  max={t.total}
                  indeterminate={indeterminate}
                  label={`${verb} ${t.fileName}`}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
