import { useCallback, useState, useRef, useEffect } from "react";
import { Virtuoso } from "react-virtuoso";
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
} from "lucide-react";
import { useAppStore, getActiveTab } from "@/store/appStore";
import { useFileBrowser } from "@/hooks/useFileBrowser";
import { onVscodeEditComplete } from "@/services/events";
import { FileEntry } from "@/types/connection";
import { SshConfig } from "@/types/terminal";
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

  return (
    <div className="file-browser__row-wrapper">
      <button
        className="file-browser__row"
        onDoubleClick={() => entry.isDirectory && onNavigate(entry)}
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
        >
          <MoreHorizontal size={14} />
        </button>
        {menuOpen && (
          <div className="file-browser__context-menu">
            {entry.isDirectory && (
              <button
                className="file-browser__context-item"
                onClick={() => {
                  setMenuOpen(false);
                  onNavigate(entry);
                }}
              >
                <FolderOpen size={14} />
                Open
              </button>
            )}
            {!entry.isDirectory && mode === "sftp" && (
              <button
                className="file-browser__context-item"
                onClick={() => {
                  setMenuOpen(false);
                  onContextAction(entry, "download");
                }}
              >
                <Download size={14} />
                Download
              </button>
            )}
            {!entry.isDirectory && vscodeAvailable && (
              <button
                className="file-browser__context-item"
                onClick={() => {
                  setMenuOpen(false);
                  onContextAction(entry, "vscode");
                }}
              >
                <CodeXml size={14} />
                Open in VS Code
              </button>
            )}
            <button
              className="file-browser__context-item"
              onClick={() => {
                setMenuOpen(false);
                onContextAction(entry, "rename");
              }}
            >
              <Pencil size={14} />
              Rename
            </button>
            <button
              className="file-browser__context-item file-browser__context-item--danger"
              onClick={() => {
                setMenuOpen(false);
                onContextAction(entry, "delete");
              }}
            >
              <Trash2 size={14} />
              Delete
            </button>
          </div>
        )}
      </div>
    </div>
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

  // Derive mode from active tab
  const activeTab = useAppStore((s) => getActiveTab(s));
  const activeTabId = activeTab?.id ?? null;
  const activeTabConnectionType = activeTab?.connectionType ?? null;
  const activeTabContentType = activeTab?.contentType ?? null;

  useEffect(() => {
    if (!activeTab || activeTabContentType === "settings") {
      setFileBrowserMode("none");
      return;
    }
    if (activeTabConnectionType === "local") {
      setFileBrowserMode("local");
    } else if (activeTabConnectionType === "ssh") {
      setFileBrowserMode("sftp");
    } else {
      setFileBrowserMode("none");
    }
  }, [activeTabId, activeTabConnectionType, activeTabContentType, setFileBrowserMode]);

  // Auto-navigate on tab switch or CWD change
  const cwd = activeTabId ? tabCwds[activeTabId] : undefined;
  useEffect(() => {
    if (sidebarView !== "files" || !cwd) return;
    const currentMode = useAppStore.getState().fileBrowserMode;
    if (currentMode === "local") {
      navigateLocal(cwd);
    } else if (currentMode === "sftp" && sftpSessionId) {
      navigateSftp(cwd);
    }
  }, [activeTabId, cwd, sidebarView, navigateLocal, navigateSftp, sftpSessionId]);

  // Auto-connect SFTP for SSH tabs
  useEffect(() => {
    if (fileBrowserMode !== "sftp" || !activeTab) return;
    if (activeTab.config.type !== "ssh") return;

    const sshConfig = activeTab.config.config as SshConfig;
    const hostKey = `${sshConfig.username}@${sshConfig.host}:${sshConfig.port}`;

    // Already connected to the right host
    if (sftpSessionId && sftpConnectedHost === hostKey) return;

    // Need to connect (or reconnect to different host)
    const doConnect = async () => {
      if (sftpSessionId && sftpConnectedHost !== hostKey) {
        await disconnectSftp();
      }

      let configToUse = sshConfig;
      if (sshConfig.authMethod === "password" && !sshConfig.password) {
        // Look for the saved connection to get any config details
        const savedConn = connections.find((c) => {
          if (c.config.type !== "ssh") return false;
          const sc = c.config.config as SshConfig;
          return sc.host === sshConfig.host && sc.port === sshConfig.port && sc.username === sshConfig.username;
        });
        const baseConfig = savedConn ? (savedConn.config.config as SshConfig) : sshConfig;

        const password = await requestPassword(sshConfig.host, sshConfig.username);
        if (password === null) return;
        configToUse = { ...baseConfig, password };
      }

      connectSftp(configToUse);
    };

    doConnect();
  }, [fileBrowserMode, activeTabId, activeTab, sftpSessionId, sftpConnectedHost, connections, connectSftp, disconnectSftp, requestPassword]);
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
    deleteEntry,
    renameEntry,
    openInVscode,
    mode,
  } = useFileBrowser();

  const disconnectSftp = useAppStore((s) => s.disconnectSftp);
  const vscodeAvailable = useAppStore((s) => s.vscodeAvailable);
  const [newDirName, setNewDirName] = useState<string | null>(null);

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

  const handleContextAction = useCallback(
    (entry: FileEntry, action: string) => {
      switch (action) {
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
    [downloadFile, openInVscode, renameEntry, deleteEntry]
  );

  const handleCreateDir = useCallback(() => {
    if (newDirName && newDirName.trim()) {
      createDirectory(newDirName.trim()).catch((err: unknown) =>
        console.error("Create directory failed:", err)
      );
      setNewDirName(null);
    }
  }, [newDirName, createDirectory]);

  // "none" mode — show placeholder
  if (mode === "none") {
    return (
      <div className="file-browser">
        <div className="file-browser__placeholder">
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
        <div className="file-browser__placeholder">
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
        <span className="file-browser__path" title={currentPath}>
          {currentPath}
        </span>
        <div className="file-browser__actions">
          <button
            className="file-browser__btn"
            onClick={navigateUp}
            disabled={currentPath === "/"}
            title="Go Up"
          >
            <ArrowUp size={14} />
          </button>
          <button className="file-browser__btn" onClick={refresh} title="Refresh">
            <RefreshCw size={14} className={isLoading ? "file-browser__spinner" : ""} />
          </button>
          {mode === "sftp" && (
            <button className="file-browser__btn" onClick={uploadFile} title="Upload File">
              <Upload size={14} />
            </button>
          )}
          <button
            className="file-browser__btn"
            onClick={() => setNewDirName("")}
            title="New Folder"
          >
            <FolderPlus size={14} />
          </button>
          {mode === "sftp" && (
            <button
              className="file-browser__btn"
              onClick={disconnectSftp}
              title="Disconnect"
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
          />
          <button className="file-browser__btn" onClick={handleCreateDir} title="Create">
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
