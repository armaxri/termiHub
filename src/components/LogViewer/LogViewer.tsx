import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Trash2, Pause, Play, Save, ClipboardCopy, FileDown } from "lucide-react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { LogEntry } from "@/types/terminal";
import { getLogs, clearLogs } from "@/services/api";
import { onLogEntry } from "@/services/events";
import "./LogViewer.css";

const MAX_ENTRIES = 2000;

const LEVELS = ["ERROR", "WARN", "INFO", "DEBUG"] as const;
type LogLevel = (typeof LEVELS)[number];

interface LogViewerProps {
  isVisible: boolean;
}

/** Log Viewer panel — displays backend tracing logs in real time. */
export function LogViewer({ isVisible }: LogViewerProps) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [activeLevels, setActiveLevels] = useState<Set<LogLevel>>(
    () => new Set(["ERROR", "WARN", "INFO", "DEBUG"])
  );
  const [search, setSearch] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  // Load buffered logs and subscribe to real-time events
  useEffect(() => {
    let cancelled = false;

    getLogs(MAX_ENTRIES)
      .then((buffered) => {
        if (!cancelled) setEntries(buffered);
      })
      .catch(() => {});

    const unlistenPromise = onLogEntry((entry) => {
      if (!cancelled) {
        setEntries((prev) => {
          const next = [...prev, entry];
          if (next.length > MAX_ENTRIES) {
            return next.slice(next.length - MAX_ENTRIES);
          }
          return next;
        });
      }
    });

    return () => {
      cancelled = true;
      unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    if (autoScroll && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [entries, autoScroll]);

  const toggleLevel = useCallback((level: LogLevel) => {
    setActiveLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) {
        next.delete(level);
      } else {
        next.add(level);
      }
      return next;
    });
  }, []);

  const handleClear = useCallback(async () => {
    try {
      await clearLogs();
      setEntries([]);
    } catch {
      // Ignore errors
    }
  }, []);

  const handleSave = useCallback(
    async (entriesToSave: LogEntry[]) => {
      try {
        const content = entriesToSave.map(formatEntry).join("\n");
        const filePath = await save({
          title: "Save logs",
          defaultPath: "termihub-logs.txt",
          filters: [{ name: "Text", extensions: ["txt", "log"] }],
        });
        if (!filePath) return;
        await writeTextFile(filePath, content);
      } catch {
        // Ignore errors (user cancelled dialog, etc.)
      }
    },
    []
  );

  const handleCopyEntry = useCallback(async (entry: LogEntry) => {
    try {
      await navigator.clipboard.writeText(formatEntry(entry));
    } catch {
      // Ignore errors
    }
  }, []);

  const searchLower = search.toLowerCase();

  const filteredEntries = useMemo(
    () =>
      entries.filter((e) => {
        if (!activeLevels.has(e.level as LogLevel)) return false;
        if (searchLower && !entryMatchesSearch(e, searchLower)) return false;
        return true;
      }),
    [entries, activeLevels, searchLower]
  );

  return (
    <div className={`log-viewer ${!isVisible ? "log-viewer--hidden" : ""}`}>
      <div className="log-viewer__toolbar">
        <div className="log-viewer__level-filters">
          {LEVELS.map((level) => (
            <button
              key={level}
              className={`log-viewer__level-btn log-viewer__level-btn--${level.toLowerCase()} ${
                activeLevels.has(level) ? "log-viewer__level-btn--active" : ""
              }`}
              onClick={() => toggleLevel(level)}
              title={`Toggle ${level} logs`}
            >
              {level}
            </button>
          ))}
        </div>
        <input
          className="log-viewer__search"
          type="text"
          placeholder="Search logs..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button
          className={`log-viewer__toolbar-btn ${autoScroll ? "log-viewer__toolbar-btn--active" : ""}`}
          onClick={() => setAutoScroll((v) => !v)}
          title={autoScroll ? "Pause auto-scroll" : "Resume auto-scroll"}
        >
          {autoScroll ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <button
          className="log-viewer__toolbar-btn"
          onClick={() => handleSave(filteredEntries)}
          title="Save logs to file"
        >
          <Save size={14} />
        </button>
        <button className="log-viewer__toolbar-btn" onClick={handleClear} title="Clear logs">
          <Trash2 size={14} />
        </button>
        <span className="log-viewer__count">{filteredEntries.length} entries</span>
      </div>
      <div className="log-viewer__list" ref={listRef}>
        {filteredEntries.length === 0 ? (
          <div className="log-viewer__empty">No log entries</div>
        ) : (
          filteredEntries.map((entry, i) => (
            <ContextMenu.Root key={i}>
              <ContextMenu.Trigger asChild>
                <div className="log-viewer__entry">
                  <span className="log-viewer__timestamp">{entry.timestamp}</span>
                  <span className={`log-viewer__level log-viewer__level--${entry.level}`}>
                    {entry.level}
                  </span>
                  <span className="log-viewer__target">{entry.target}</span>
                  <span className="log-viewer__message">{entry.message}</span>
                </div>
              </ContextMenu.Trigger>
              <ContextMenu.Portal>
                <ContextMenu.Content className="context-menu__content">
                  <ContextMenu.Item
                    className="context-menu__item"
                    onSelect={() => handleCopyEntry(entry)}
                  >
                    <ClipboardCopy size={14} /> Copy Entry
                  </ContextMenu.Item>
                  <ContextMenu.Separator className="context-menu__separator" />
                  <ContextMenu.Item
                    className="context-menu__item"
                    onSelect={() => handleSave(filteredEntries)}
                  >
                    <FileDown size={14} /> Save All Logs
                  </ContextMenu.Item>
                </ContextMenu.Content>
              </ContextMenu.Portal>
            </ContextMenu.Root>
          ))
        )}
      </div>
    </div>
  );
}

function entryMatchesSearch(entry: LogEntry, searchLower: string): boolean {
  return (
    entry.message.toLowerCase().includes(searchLower) ||
    entry.target.toLowerCase().includes(searchLower) ||
    entry.level.toLowerCase().includes(searchLower)
  );
}

function formatEntry(entry: LogEntry): string {
  return `${entry.timestamp} [${entry.level}] ${entry.target}: ${entry.message}`;
}
