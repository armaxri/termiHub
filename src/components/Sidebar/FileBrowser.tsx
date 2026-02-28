import { useCallback, useState, useRef, useEffect } from "react";
import { Virtuoso } from "react-virtuoso";
import * as ContextMenu from "@radix-ui/react-context-menu";
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
  mode: "local" | "sftp" | "none";
  vscodeAvailable: boolean;
  onNavigate: (entry: FileEntry) => void;
  onContextAction: (entry: FileEntry, action: string) => void;
}

/**
 * Shared menu items for file/directory actions.
 * Used by both the three-dots dropdown and the right-click context menu.
 */
function FileMenuItems({
  entry,
  mode,
  vscodeAvailable,
  onNavigate,
  onContextAction,
  onClose,
}: {
  entry: FileEntry;
  mode: "local" | "sftp" | "none";
  vscodeAvailable: boolean;
  onNavigate: (entry: FileEntry) => void;
  onContextAction: (entry: FileEntry, action: string) => void;
  onClose: () => void;
}) {
  return (
    <>
      {entry.isDirectory && (
        <button
          className="file-browser__context-item"
          onClick={() => {
            onClose();
            onNavigate(entry);
          }}
          data-testid="file-menu-open"
        >
          <FolderOpen size={14} /> Open
        </button>
      )}
      {!entry.isDirectory && mode === "sftp" && (
        <button
          className="file-browser__context-item"
          onClick={() => {
            onClose();
            onContextAction(entry, "download");
          }}
          data-testid="file-menu-download"
        >
          <Download size={14} /> Download
        </button>
      )}
      {!entry.isDirectory && (
        <button
          className="file-browser__context-item"
          onClick={() => {
            onClose();
            onContextAction(entry, "edit");
          }}
          data-testid="file-menu-edit"
        >
          <FileEdit size={14} /> Edit
        </button>
      )}
      {!entry.isDirectory && vscodeAvailable && (
        <button
          className="file-browser__context-item"
          onClick={() => {
            onClose();
            onContextAction(entry, "vscode");
          }}
          data-testid="file-menu-vscode"
        >
          <CodeXml size={14} /> Open in VS Code
        </button>
      )}
      <button
        className="file-browser__context-item"
        onClick={() => {
          onClose();
          onContextAction(entry, "rename");
        }}
        data-testid="file-menu-rename"
      >
        <Pencil size={14} /> Rename
      </button>
      <button
        className="file-browser__context-item file-browser__context-item--danger"
        onClick={() => {
          onClose();
          onContextAction(entry, "delete");
        }}
        data-testid="file-menu-delete"
      >
        <Trash2 size={14} /> Delete
      </button>
    </>
  );
}

function FileRow({ entry, mode, vscodeAvailable, onNavigate, onContextAction }: FileRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpen]);

  const menuItemProps = { entry, mode, vscodeAvailable, onNavigate, onContextAction };

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div className="file-browser__row-wrapper">
          <button
            className="file-browser__row"
            data-testid={`file-row-${entry.name}`}
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
          <div className="file-browser__row-menu" ref={menuRef}>
            <button
              className="file-browser__btn file-browser__btn--menu"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen(!menuOpen);
              }}
              title="Actions"
              data-testid={`file-row-menu-${entry.name}`}
            >
              <MoreHorizontal size={14} />
            </button>
            {menuOpen && (
              <div className="file-browser__context-menu">
                <FileMenuItems {...menuItemProps} onClose={() => setMenuOpen(false)} />
              </div>
            )}
          </div>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="context-menu__content">
          {entry.isDirectory && (
            <ContextMenu.Item
              className="context-menu__item"
              onSelect={() => onNavigate(entry)}
              data-testid="context-file-open"
            >
              <FolderOpen size={14} /> Open
            </ContextMenu.Item>
          )}
          {!entry.isDirectory && mode === "sftp" && (
            <ContextMenu.Item
              className="context-menu__item"
              onSelect={() => onContextAction(entry, "download")}
              data-testid="context-file-download"
            >
              <Download size={14} /> Download
            </ContextMenu.Item>
          )}
          {!entry.isDirectory && (
            <ContextMenu.Item
              className="context-menu__item"
              onSelect={() => onContextAction(entry, "edit")}
              data-testid="context-file-edit"
            >
              <FileEdit size={14} /> Edit
            </ContextMenu.Item>
          )}
          {!entry.isDirectory && vscodeAvailable && (
            <ContextMenu.Item
              className="context-menu__item"
              onSelect={() => onContextAction(entry, "vscode")}
              data-testid="context-file-vscode"
            >
              <CodeXml size={14} /> Open in VS Code
            </ContextMenu.Item>
          )}
          <ContextMenu.Separator className="context-menu__separator" />
          <ContextMenu.Item
            className="context-menu__item"
            onSelect={() => onContextAction(entry, "rename")}
            data-testid="context-file-rename"
          >
            <Pencil size={14} /> Rename
          </ContextMenu.Item>
          <ContextMenu.Item
            className="context-menu__item context-menu__item--danger"
            onSelect={() => onContextAction(entry, "delete")}
            data-testid="context-file-delete"
          >
            <Trash2 size={14} /> Delete
          </ContextMenu.Item>
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
  const connectSftp = useAppStore((s) => s.connectSftp);
  const disconnectSftp = useAppStore((s) => s.disconnectSftp);
  const sftpSessionId = useAppStore((s) => s.sftpSessionId);
  const sftpConnectedHost = useAppStore((s) => s.sftpConnectedHost);
  const requestPassword = useAppStore((s) => s.requestPassword);
  const connections = useAppStore((s) => s.connections);
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
      ? (((activeTab.config.config.shell ?? activeTab.config.config.shellType) as ShellType) ?? null)
      : null;
  const wslDistro = activeTabShellType ? getWslDistroName(activeTabShellType) : null;

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
    if (activeTabConnectionType === "local") {
      setFileBrowserMode("local");
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
    connectionTypes,
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
    sftpSessionId,
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
}

export function FileBrowser() {
  useFileBrowserSync();

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
    mode,
  } = useFileBrowser();

  const disconnectSftp = useAppStore((s) => s.disconnectSftp);
  const vscodeAvailable = useAppStore((s) => s.vscodeAvailable);
  const [newDirName, setNewDirName] = useState<string | null>(null);
  const [newFileName, setNewFileName] = useState<string | null>(null);

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
          useAppStore
            .getState()
            .openEditorTab(
              entry.path,
              mode === "sftp",
              mode === "sftp" ? (sftpSessionId ?? undefined) : undefined
            );
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
    [mode, sftpSessionId, downloadFile, openInVscode, renameEntry, deleteEntry]
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
            disabled={currentPath === "/"}
            title="Go Up"
            data-testid="file-browser-up"
          >
            <ArrowUp size={14} />
          </button>
          <button
            className="file-browser__btn"
            onClick={refresh}
            title="Refresh"
            data-testid="file-browser-refresh"
          >
            <RefreshCw size={14} className={isLoading ? "file-browser__spinner" : ""} />
          </button>
          {mode === "sftp" && (
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

      {isLoading && fileEntries.length === 0 ? (
        <div className="file-browser__loading">
          <Loader2 size={20} className="file-browser__spinner" />
          <span>Loading...</span>
        </div>
      ) : (
        <div className="file-browser__list">
          <Virtuoso
            totalCount={sortedEntries.length}
            itemContent={(index) => (
              <FileRow
                entry={sortedEntries[index]}
                mode={mode}
                vscodeAvailable={vscodeAvailable}
                onNavigate={handleNavigate}
                onContextAction={handleContextAction}
              />
            )}
            style={{ height: "100%" }}
          />
        </div>
      )}
    </div>
  );
}
