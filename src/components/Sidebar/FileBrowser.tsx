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
} from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useFileSystem } from "@/hooks/useFileSystem";
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
  onNavigate: (entry: FileEntry) => void;
  onContextAction: (entry: FileEntry, action: string) => void;
}

function FileRow({ entry, onNavigate, onContextAction }: FileRowProps) {
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
            {!entry.isDirectory && (
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

/** Connection picker shown when no SFTP session is active. */
function ConnectionPicker() {
  const connections = useAppStore((s) => s.connections);
  const connectSftp = useAppStore((s) => s.connectSftp);
  const sftpLoading = useAppStore((s) => s.sftpLoading);
  const sftpError = useAppStore((s) => s.sftpError);
  const [selectedId, setSelectedId] = useState<string>("");

  const sshConnections = connections.filter((c) => c.config.type === "ssh");

  const handleConnect = useCallback(() => {
    const conn = sshConnections.find((c) => c.id === selectedId);
    if (!conn) return;
    connectSftp(conn.config.config as SshConfig);
  }, [selectedId, sshConnections, connectSftp]);

  return (
    <div className="file-browser__picker">
      <div className="file-browser__picker-label">Connect to SSH host to browse files</div>
      {sshConnections.length === 0 ? (
        <div className="file-browser__picker-empty">
          No SSH connections saved. Create one in the Connections view.
        </div>
      ) : (
        <>
          <select
            className="file-browser__picker-select"
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
          >
            <option value="">Select connection...</option>
            {sshConnections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({(c.config.config as SshConfig).username}@{(c.config.config as SshConfig).host})
              </option>
            ))}
          </select>
          <button
            className="file-browser__picker-btn"
            onClick={handleConnect}
            disabled={!selectedId || sftpLoading}
          >
            {sftpLoading ? (
              <>
                <Loader2 size={14} className="file-browser__spinner" />
                Connecting...
              </>
            ) : (
              "Connect"
            )}
          </button>
        </>
      )}
      {sftpError && (
        <div className="file-browser__error">
          <AlertCircle size={14} />
          <span>{sftpError}</span>
        </div>
      )}
    </div>
  );
}

export function FileBrowser() {
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
  } = useFileSystem();

  const disconnectSftp = useAppStore((s) => s.disconnectSftp);
  const [newDirName, setNewDirName] = useState<string | null>(null);

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
          downloadFile(entry.path, entry.name).catch((err) =>
            console.error("Download failed:", err)
          );
          break;
        case "rename": {
          const newName = window.prompt("New name:", entry.name);
          if (newName && newName !== entry.name) {
            renameEntry(entry.path, newName).catch((err) =>
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
            deleteEntry(entry.path, entry.isDirectory).catch((err) =>
              console.error("Delete failed:", err)
            );
          }
          break;
        }
      }
    },
    [downloadFile, renameEntry, deleteEntry]
  );

  const handleCreateDir = useCallback(() => {
    if (newDirName && newDirName.trim()) {
      createDirectory(newDirName.trim()).catch((err) =>
        console.error("Create directory failed:", err)
      );
      setNewDirName(null);
    }
  }, [newDirName, createDirectory]);

  if (!isConnected) {
    return (
      <div className="file-browser">
        <ConnectionPicker />
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
          <button className="file-browser__btn" onClick={uploadFile} title="Upload File">
            <Upload size={14} />
          </button>
          <button
            className="file-browser__btn"
            onClick={() => setNewDirName("")}
            title="New Folder"
          >
            <FolderPlus size={14} />
          </button>
          <button
            className="file-browser__btn"
            onClick={disconnectSftp}
            title="Disconnect"
          >
            <Unplug size={14} />
          </button>
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
