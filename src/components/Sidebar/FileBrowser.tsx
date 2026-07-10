import { useCallback, useState, useEffect, useRef, useMemo } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { writeText as writeClipboard } from "@tauri-apps/plugin-clipboard-manager";
import {
  Folder,
  File,
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
  findTypeAheadIndex,
  type FileSortKey,
  type SortDirection,
} from "@/utils/fileBrowserNav";
import { resolveFeatureEnabled } from "@/utils/featureFlags";
import { useOsFileDrop } from "@/hooks/useOsFileDrop";
import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";
import { FileBrowserPathBar } from "./FileBrowserPathBar";
import "./FileBrowser.css";

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
              if (entry.isDirectory) {
                onNavigate(entry);
              } else {
                onContextAction(entry, "edit");
              }
            }}
          >
            {entry.isDirectory ? (
              <Folder size={16} className="file-browser__icon file-browser__icon--folder" />
            ) : (
              <File size={16} className="file-browser__icon" />
            )}
            <span className="file-browser__name">{entry.name}</span>
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
  const connectSftp = useAppStore((s) => s.connectSftp);
  const sftpSessionId = useAppStore((s) => s.sftpSessionId);
  const sftpConnectedHost = useAppStore((s) => s.sftpConnectedHost);
  const sessionFileBrowserId = useAppStore((s) => s.sessionFileBrowserId);
  const requestPassword = useAppStore((s) => s.requestPassword);
  const localCurrentPath = useAppStore((s) => s.localCurrentPath);
  const sftpCurrentPath = useAppStore((s) => s.currentPath);
  const sessionCurrentPath = useAppStore((s) => s.sessionCurrentPath);
  const connections = useAppStore((s) => s.connections);
  const remoteAgents = useAppStore((s) => s.remoteAgents);
  const fileBrowserMode = useAppStore((s) => s.fileBrowserMode);
  const globalFileBrowserEnabled = useAppStore((s) => s.settings.fileBrowserEnabled);

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
      // Editor tabs: derive mode from file location
      if (activeTabEditorMeta?.isRemote) {
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
      setFileBrowserMode(fileBrowserEnabled ? "sftp" : "none");
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

  // Auto-connect SFTP for tabs with file browser capability
  useEffect(() => {
    // Editor tabs use a dummy local config — skip SFTP auto-connect for them.
    // The session they need is already stored in editorMeta.sftpSessionId.
    if (fileBrowserMode !== "sftp" || !activeTab || activeTabContentType === "editor") return;

    const cfg = activeTab.config.config;
    const host = (cfg.host as string) ?? "";
    const port = (cfg.port as number) ?? 0;
    const username = (cfg.username as string) ?? "";
    const hostKey = `${username}@${host}:${port}`;

    // Already connected to the right host
    if (sftpSessionId && sftpConnectedHost === hostKey) return;

    const owningTabId = activeTabId ?? undefined;

    // Need to connect (or switch to a different host). We no longer close the
    // previous session here: each tab owns its own SFTP session, so the store's
    // connectSftp leaves a still-owned previous session registered (and closes
    // it only if its owning tab is gone). Sessions are closed on tab close (#1241).
    const doConnect = async () => {
      let configToUse = cfg;
      const authMethod = cfg.authMethod as string | undefined;
      if (authMethod === "password" && !cfg.password) {
        // Look for the saved connection to get any config details
        const savedConn = connections.find((c) => {
          const sc = c.config.config;
          return sc.host === host && sc.port === port && sc.username === username;
        });
        const baseConfig = savedConn ? savedConn.config.config : cfg;

        const password = await requestPassword(host, username);
        if (password === null) return;
        configToUse = { ...baseConfig, password };
      }

      connectSftp(configToUse, owningTabId);
    };

    doConnect();
  }, [
    fileBrowserMode,
    activeTabId,
    activeTab,
    activeTabContentType,
    sftpSessionId,
    sftpConnectedHost,
    connections,
    connectSftp,
    requestPassword,
  ]);

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
  const fileClipboard = useAppStore((s) => s.fileClipboard);
  const quickShareServer = useAppStore((s) => s.quickShareServer);
  const setSidebarView = useAppStore((s) => s.setSidebarView);
  const [newDirName, setNewDirName] = useState<string | null>(null);
  const [newFileName, setNewFileName] = useState<string | null>(null);
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
  // Roving-tabindex focus index into `displayEntries` for keyboard navigation.
  const [activeIndex, setActiveIndex] = useState(0);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const rowRefCbs = useRef<Map<number, (el: HTMLButtonElement | null) => void>>(new Map());
  const typeAhead = useRef<{ buffer: string; ts: number }>({ buffer: "", ts: 0 });

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

  // Stable per-index ref callback so rows don't detach/reattach every render.
  const getRowRef = useCallback((index: number) => {
    const cache = rowRefCbs.current;
    let cb = cache.get(index);
    if (!cb) {
      cb = (el: HTMLButtonElement | null) => {
        rowRefs.current[index] = el;
      };
      cache.set(index, cb);
    }
    return cb;
  }, []);

  // Keep the active index in range as the list length changes.
  useEffect(() => {
    setActiveIndex((i) => Math.min(Math.max(0, i), Math.max(0, displayEntries.length - 1)));
  }, [displayEntries.length]);

  // Listen for VS Code edit-complete events (remote file re-upload)
  useEffect(() => {
    let cleanup: (() => void) | null = null;
    onVscodeEditComplete((remotePath, success, err) => {
      if (success) {
        refresh();
      } else {
        console.error(`VS Code edit failed for ${remotePath}:`, err);
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
    setActiveIndex(0);
    setFilterQuery("");
  }, [clearSelection]);

  const handleNavigatePath = useCallback(
    (path: string) => {
      resetNavState();
      navigateTo(path);
    },
    [navigateTo, resetNavState]
  );

  const handleNavigate = useCallback(
    (entry: FileEntry) => {
      if (entry.isDirectory) handleNavigatePath(entry.path);
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
                mode === "sftp" ? (sftpSessionId ?? undefined) : undefined
              );
          }
          // session mode: file editing via editor not yet supported for agent sessions
          break;
        case "download":
          // downloadFile surfaces its own success/error toast (see useFileSystem).
          void downloadFile(entry.path, entry.name);
          break;
        case "vscode":
          openInVscode(entry.path).catch((err: unknown) =>
            console.error("Open in VS Code failed:", err)
          );
          break;
        case "copy":
          copyEntry([entry]);
          break;
        case "cut":
          cutEntry([entry]);
          break;
        case "copyName":
          writeClipboard(entry.name);
          break;
        case "copyPath":
          writeClipboard(entry.path);
          break;
        case "rename": {
          const newName = window.prompt("New name:", entry.name);
          if (newName && newName !== entry.name) {
            renameEntry(entry.path, newName).catch((err: unknown) =>
              console.error("Rename failed:", err)
            );
          }
          break;
        }
        case "delete": {
          setDeleteConfirm({
            message: `Delete ${entry.isDirectory ? "directory" : "file"} "${entry.name}"?`,
            onConfirm: () => {
              deleteEntry(entry.path, entry.isDirectory).catch((err: unknown) =>
                console.error("Delete failed:", err)
              );
            },
          });
          break;
        }
      }
    },
    [mode, sftpSessionId, downloadFile, openInVscode, copyEntry, cutEntry, renameEntry, deleteEntry]
  );

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
    [displayEntries, lastClickedPath]
  );

  // Move the roving focus/selection to `index`. With `extend`, grows the
  // selection from the anchor (last click) to `index`; otherwise selects just
  // the target. Focus follows so keyboard and screen-reader users stay in sync.
  const moveActive = useCallback(
    (index: number, extend: boolean) => {
      const entry = displayEntries[index];
      if (!entry) return;
      setActiveIndex(index);
      rowRefs.current[index]?.focus();
      if (extend && lastClickedPath) {
        const anchorIdx = displayEntries.findIndex((fe) => fe.path === lastClickedPath);
        if (anchorIdx >= 0) {
          const [start, end] = anchorIdx < index ? [anchorIdx, index] : [index, anchorIdx];
          setSelectedPaths(new Set(displayEntries.slice(start, end + 1).map((fe) => fe.path)));
          return;
        }
      }
      setSelectedPaths(new Set([entry.path]));
      setLastClickedPath(entry.path);
    },
    [displayEntries, lastClickedPath]
  );

  const handleListKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const entries = displayEntries;
      const len = entries.length;
      const key = e.key;

      if ((e.ctrlKey || e.metaKey) && key.toLowerCase() === "a") {
        e.preventDefault();
        setSelectedPaths(new Set(entries.map((fe) => fe.path)));
        if (entries.length > 0) setLastClickedPath(entries[entries.length - 1].path);
        return;
      }
      if (key === "Escape") {
        clearSelection();
        return;
      }
      if (key === "Backspace" || (e.altKey && key === "ArrowLeft")) {
        e.preventDefault();
        handleNavigateUp();
        return;
      }
      if (len === 0) return;

      if (key === "ArrowDown" || key === "ArrowUp") {
        e.preventDefault();
        const delta = key === "ArrowDown" ? 1 : -1;
        moveActive(Math.min(len - 1, Math.max(0, activeIndex + delta)), e.shiftKey);
        return;
      }
      if (key === "Home" || key === "End") {
        e.preventDefault();
        moveActive(key === "Home" ? 0 : len - 1, e.shiftKey);
        return;
      }
      if (key === "Enter") {
        e.preventDefault();
        const entry = entries[activeIndex];
        if (!entry) return;
        if (entry.isDirectory) handleNavigate(entry);
        else handleContextAction(entry, "edit");
        return;
      }
      // Type-ahead: a printable character with no command modifiers.
      if (key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const now = Date.now();
        const ta = typeAhead.current;
        const fresh = now - ta.ts > 700;
        ta.buffer = fresh ? key : ta.buffer + key;
        ta.ts = now;
        const idx = findTypeAheadIndex(entries, ta.buffer, activeIndex, ta.buffer.length === 1);
        if (idx >= 0) moveActive(idx, false);
      }
    },
    [
      displayEntries,
      activeIndex,
      moveActive,
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
              Promise.all(entries.map((e) => deleteEntry(e.path, e.isDirectory))).catch(
                (err: unknown) => console.error("Delete failed:", err)
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
      createDirectory(newDirName.trim()).catch((err: unknown) =>
        console.error("Create directory failed:", err)
      );
      setNewDirName(null);
    }
  }, [newDirName, createDirectory]);

  const handleCreateFile = useCallback(() => {
    if (newFileName && newFileName.trim()) {
      createFile(newFileName.trim()).catch((err: unknown) =>
        console.error("Create file failed:", err)
      );
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

  // In-flight transfers owned by the SFTP session this browser is showing
  // (#1247). Only these belong in the footer; other sessions' transfers live in
  // the Open Connections panel. The list above stays live regardless.
  const activeTransfers = sftpSessionId
    ? Object.values(transfers).filter((t) => t.sessionId === sftpSessionId)
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
          <input
            className="file-browser__new-dir-input"
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
          <input
            className="file-browser__new-dir-input"
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
              className="file-browser__list"
              data-testid="file-browser-list"
              onKeyDown={handleListKeyDown}
              onClick={(e) => {
                if (e.target === e.currentTarget) clearSelection();
              }}
            >
              {displayEntries.length === 0 ? (
                <div className="file-browser__empty">
                  {filterQuery ? "No files match the filter" : "This folder is empty"}
                </div>
              ) : (
                displayEntries.map((entry, index) => (
                  <FileRow
                    key={entry.path}
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
                  />
                ))
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
