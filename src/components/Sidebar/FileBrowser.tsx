import { useCallback } from "react";
import { Virtuoso } from "react-virtuoso";
import {
  Folder,
  File,
  ArrowUp,
  RefreshCw,
} from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { FileEntry } from "@/types/connection";
import "./FileBrowser.css";

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface FileRowProps {
  entry: FileEntry;
  onNavigate: (entry: FileEntry) => void;
}

function FileRow({ entry, onNavigate }: FileRowProps) {
  return (
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
    </button>
  );
}

export function FileBrowser() {
  const fileEntries = useAppStore((s) => s.fileEntries);
  const currentPath = useAppStore((s) => s.currentPath);
  const setCurrentPath = useAppStore((s) => s.setCurrentPath);

  const handleNavigate = useCallback(
    (entry: FileEntry) => {
      if (entry.isDirectory) {
        setCurrentPath(entry.path);
      }
    },
    [setCurrentPath]
  );

  const handleGoUp = useCallback(() => {
    const parentPath = currentPath.split("/").slice(0, -1).join("/") || "/";
    setCurrentPath(parentPath);
  }, [currentPath, setCurrentPath]);

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
            onClick={handleGoUp}
            title="Go Up"
          >
            <ArrowUp size={14} />
          </button>
          <button
            className="file-browser__btn"
            title="Refresh"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>
      <div className="file-browser__list">
        <Virtuoso
          totalCount={sortedEntries.length}
          itemContent={(index) => (
            <FileRow
              entry={sortedEntries[index]}
              onNavigate={handleNavigate}
            />
          )}
          style={{ height: "100%" }}
        />
      </div>
    </div>
  );
}
