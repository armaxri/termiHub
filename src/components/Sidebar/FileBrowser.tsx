import { useCallback, useState, useEffect } from "react";
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
} from "lucide-react";
import { useAppStore, getActiveTab } from "@/store/appStore";
import { useFileBrowser } from "@/hooks/useFileBrowser";
import { onVscodeEditComplete } from "@/services/events";
import { getHomeDir } from "@/services/api";
import { FileEntry } from "@/types/connection";
import type { ShellType } from "@/types/terminal";
import type { ConnectionTypeInfo } from "@/services/api";
import { getWslDistroName, wslToWindowsPath } from "@/utils/shell-detection";
import { resolveFeatureEnabled } from "@/utils/featureFlags";
import "./FileBrowser.css";

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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
}: FileRowProps) {
  const menuItemProps = {
    entry,
    vscodeAvailable,
    onNavigate,
    onContextAction,
    onPaste,
    hasClipboard,
  };

  const showMultiSelect = isSelected && selectedCount > 1;

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          className={`file-browser__row-wrapper${isSelected ? " file-browser__row-wrapper--selected" : ""}`}
        >
          <button
            className="file-browser__row"
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
            {!entry.isDirectory && (
              <span className="file-browser__size">{formatFileSize(entry.size)}</span>
            )}
            {entry.permissions && (
              <span className="file-browser__permissions">{entry.permissions}</span>
            )}
          </button>
          <div className="file-browser__row-menu">
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  className="file-browser__btn file-browser__btn--menu"
                  title="Actions"
                  data-testid={`file-row-menu-${entry.name}`}
                >
                  <MoreHorizontal size={14} />
                </button>
              </DropdownMenu.Trigger>
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
  const disconnectSftp = useAppStore((s) => s.disconnectSftp);
  const sftpSessionId = useAppStore((s) => s.sftpSessionId);
  const sftpConnectedHost = useAppStore((s) => s.sftpConnectedHost);
  const sessionFileBrowserId = useAppStore((s) => s.sessionFileBrowserId);
  const requestPassword = useAppStore((s) => s.requestPassword);
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
    navigateSession(sessionFileBrowserId, cwd ?? "/");
  }, [fileBrowserMode, sessionFileBrowserId, navigateSession, cwd]);

  // Auto-connect SFTP for tabs with file browser capability
  useEffect(() => {
    if (fileBrowserMode !== "sftp" || !activeTab) return;

    const cfg = activeTab.config.config;
    const host = (cfg.host as string) ?? "";
    const port = (cfg.port as number) ?? 0;
    const username = (cfg.username as string) ?? "";
    const hostKey = `${username}@${host}:${port}`;

    // Already connected to the right host
    if (sftpSessionId && sftpConnectedHost === hostKey) return;

    // Need to connect (or reconnect to different host)
    const doConnect = async () => {
      if (sftpSessionId && sftpConnectedHost !== hostKey) {
        await disconnectSftp();
      }

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

      connectSftp(configToUse);
    };

    doConnect();
  }, [
    fileBrowserMode,
    activeTabId,
    activeTab,
    sftpSessionId,
    sftpConnectedHost,
    connections,
    connectSftp,
    disconnectSftp,
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

  return { navigateToCwd, hasCwd: !!cwd };
}

export function FileBrowser() {
  const { navigateToCwd, hasCwd } = useFileBrowserSync();

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

  const disconnectSftp = useAppStore((s) => s.disconnectSftp);
  const vscodeAvailable = useAppStore((s) => s.vscodeAvailable);
  const fileClipboard = useAppStore((s) => s.fileClipboard);
  const [newDirName, setNewDirName] = useState<string | null>(null);
  const [newFileName, setNewFileName] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [lastClickedPath, setLastClickedPath] = useState<string | null>(null);

  // Listen for VS Code edit-complete events (remote file re-upload)
  useEffect(() => {
    const unlisten = onVscodeEditComplete((remotePath, success, err) => {
      if (success) {
        refresh();
      } else {
        console.error(`VS Code edit failed for ${remotePath}:`, err);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [refresh]);

  const handleNavigate = useCallback(
    (entry: FileEntry) => {
      if (entry.isDirectory) {
        setSelectedPaths(new Set());
        setLastClickedPath(null);
        navigateTo(entry.path);
      }
    },
    [navigateTo]
  );

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
          downloadFile(entry.path, entry.name).catch((err: unknown) =>
            console.error("Download failed:", err)
          );
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
          const ok = window.confirm(
            `Delete ${entry.isDirectory ? "directory" : "file"} "${entry.name}"?`
          );
          if (ok) {
            deleteEntry(entry.path, entry.isDirectory).catch((err: unknown) =>
              console.error("Delete failed:", err)
            );
          }
          break;
        }
      }
    },
    [mode, sftpSessionId, downloadFile, openInVscode, copyEntry, cutEntry, renameEntry, deleteEntry]
  );

  const handlePaste = useCallback(() => {
    pasteEntry().catch((err: unknown) => console.error("Paste failed:", err));
  }, [pasteEntry]);

  const handleRowClick = useCallback(
    (entry: FileEntry, e: React.MouseEvent) => {
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
        // Range-select from lastClickedPath to this entry using the current sorted list
        const sortedPaths = [...fileEntries]
          .sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
            return a.name.localeCompare(b.name);
          })
          .map((fe) => fe.path);
        const anchorIdx = sortedPaths.indexOf(lastClickedPath);
        const targetIdx = sortedPaths.indexOf(entry.path);
        if (anchorIdx >= 0 && targetIdx >= 0) {
          const [start, end] =
            anchorIdx < targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx];
          setSelectedPaths(new Set(sortedPaths.slice(start, end + 1)));
        }
      } else {
        // Plain click: select only this entry
        setSelectedPaths(new Set([entry.path]));
        setLastClickedPath(entry.path);
      }
    },
    [fileEntries, lastClickedPath]
  );

  const handleMultiAction = useCallback(
    (entries: FileEntry[], action: string) => {
      switch (action) {
        case "copy":
          copyEntry(entries);
          break;
        case "cut":
          cutEntry(entries);
          break;
        case "delete": {
          const ok = window.confirm(`Delete ${entries.length} items?`);
          if (ok) {
            Promise.all(entries.map((e) => deleteEntry(e.path, e.isDirectory))).catch(
              (err: unknown) => console.error("Delete failed:", err)
            );
            setSelectedPaths(new Set());
            setLastClickedPath(null);
          }
          break;
        }
      }
    },
    [copyEntry, cutEntry, deleteEntry]
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
          {isLoading ? (
            <>
              <Loader2 size={20} className="file-browser__spinner" />
              <span>Connecting SFTP...</span>
            </>
          ) : error ? (
            <>
              <AlertCircle size={20} />
              <span>{error}</span>
            </>
          ) : (
            <span>Waiting for SFTP connection...</span>
          )}
        </div>
      </div>
    );
  }

  const sortedEntries = [...fileEntries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const selectedEntries = sortedEntries.filter((e) => selectedPaths.has(e.path));

  return (
    <div className="file-browser">
      <div className="file-browser__toolbar">
        <span
          className="file-browser__path"
          title={currentPath}
          data-testid="file-browser-current-path"
        >
          {currentPath}
        </span>
        <div className="file-browser__actions">
          <button
            className="file-browser__btn"
            onClick={navigateUp}
            disabled={currentPath === "/" || /^[A-Za-z]:\/?$/.test(currentPath)}
            title="Go Up"
            data-testid="file-browser-up"
          >
            <ArrowUp size={14} />
          </button>
          <button
            className="file-browser__btn"
            onClick={navigateToCwd}
            disabled={!hasCwd}
            title="Go to Terminal CWD"
            data-testid="file-browser-go-to-cwd"
          >
            <FolderSync size={14} />
          </button>
          <button
            className="file-browser__btn"
            onClick={refresh}
            title="Refresh"
            data-testid="file-browser-refresh"
          >
            <RefreshCw size={14} className={isLoading ? "file-browser__spinner" : ""} />
          </button>
          {(mode === "sftp" || mode === "session") && (
            <button
              className="file-browser__btn"
              onClick={uploadFile}
              title="Upload File"
              data-testid="file-browser-upload"
            >
              <Upload size={14} />
            </button>
          )}
          <button
            className="file-browser__btn"
            onClick={handlePaste}
            disabled={!fileClipboard}
            title={
              fileClipboard
                ? fileClipboard.entries.length === 1
                  ? `Paste "${fileClipboard.entries[0].name}" (${fileClipboard.operation})`
                  : `Paste ${fileClipboard.entries.length} items (${fileClipboard.operation})`
                : "Paste"
            }
            data-testid="file-browser-paste"
          >
            <ClipboardPaste size={14} />
          </button>
          <button
            className="file-browser__btn"
            onClick={() => setNewFileName("")}
            title="New File"
            data-testid="file-browser-new-file"
          >
            <FilePlus size={14} />
          </button>
          <button
            className="file-browser__btn"
            onClick={() => setNewDirName("")}
            title="New Folder"
            data-testid="file-browser-new-folder"
          >
            <FolderPlus size={14} />
          </button>
          {mode === "sftp" && (
            <button
              className="file-browser__btn"
              onClick={disconnectSftp}
              title="Disconnect"
              data-testid="file-browser-disconnect"
            >
              <Unplug size={14} />
            </button>
          )}
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
          <button
            className="file-browser__btn"
            onClick={handleCreateFile}
            title="Create"
            data-testid="file-browser-new-file-confirm"
          >
            <FilePlus size={14} />
          </button>
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
          <button
            className="file-browser__btn"
            onClick={handleCreateDir}
            title="Create"
            data-testid="file-browser-new-folder-confirm"
          >
            <FolderPlus size={14} />
          </button>
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
            <div className="file-browser__list">
              {sortedEntries.map((entry) => (
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
                  onMultiContextAction={(action) => handleMultiAction(selectedEntries, action)}
                />
              ))}
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
    </div>
  );
}
