import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Trash2, Pause, Play, Save, ClipboardCopy, FileDown } from "lucide-react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { save } from "@/services/nativeDialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogEntry } from "@/types/terminal";
import { Button, SearchInput, toast } from "@/components/ui";
import { getLogs, clearLogs } from "@/services/api";
import { onLogEntry } from "@/services/events";
import {
  clearFrontendLogHistory,
  frontendError,
  frontendWarn,
  onFrontendLog,
} from "@/utils/frontendLog";
import { errorMessage } from "@/utils/errorMessage";
import { subscribeGuarded } from "@/hooks/useTauriListener";
import { redactLogText } from "@/utils/redactLogText";
import "./LogViewer.css";

const MAX_ENTRIES = 2000;

/**
 * Target the backend re-emits forwarded frontend WARN/ERROR entries under
 * (`record_frontend_log`, OBS-001), tagged with the forwarding window's label.
 */
const BACKEND_FRONTEND_ECHO_TARGET = "frontend";

/**
 * Whether `entry` is the backend echo of a frontend entry raised in THIS window.
 * The viewer already shows the direct `frontend::<module>` copy from this
 * window's frontend log history, so it drops that echo instead of listing every
 * frontend warning twice (#4327, OBS2-004). Echoes from other windows are the
 * only way their warnings reach this viewer, so they are kept (#4535). An echo
 * without a window label cannot be attributed and is dropped, as before.
 */
function isOwnFrontendEcho(entry: LogEntry, ownWindow: string): boolean {
  if (entry.target !== BACKEND_FRONTEND_ECHO_TARGET) return false;
  return entry.window === undefined || entry.window === ownWindow;
}

/** Label of the window hosting this viewer, or `""` outside the Tauri runtime. */
function currentWindowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    // No Tauri window (browser/test without the IPC): nothing to attribute to.
    return "";
  }
}

/** The target column: a cross-window echo also names the window it came from. */
function displayTarget(entry: LogEntry): string {
  return entry.window ? `${entry.target} (${entry.window})` : entry.target;
}

function capEntries(entries: LogEntry[]): LogEntry[] {
  return entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries;
}

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
    const ownWindow = currentWindowLabel();
    const isOwnEcho = (entry: LogEntry) => isOwnFrontendEcho(entry, ownWindow);

    const addEntry = (entry: LogEntry) => {
      if (!cancelled) {
        setEntries((prev) => capEntries([...prev, entry]));
      }
    };

    // Seed from the frontend log history, replacing (not appending to) state so
    // StrictMode's second effect run cannot list the replayed entries twice.
    const replayed: LogEntry[] = [];
    let replaying = true;
    const unsubFrontend = onFrontendLog(
      (entry) => (replaying ? replayed.push(entry) : addEntry(entry)),
      { replayHistory: true }
    );
    replaying = false;
    setEntries(capEntries(replayed));

    getLogs(MAX_ENTRIES)
      .then((buffered) => {
        if (!cancelled) {
          // Prepend the backend backlog to the frontend entries already shown.
          const backend = buffered.filter((entry) => !isOwnEcho(entry));
          setEntries((prev) => capEntries([...backend, ...prev]));
        }
      })
      .catch((err: unknown) => {
        // Live entries still stream in; only the backlog is missing. Say so in
        // the log itself (frontend entries reach this viewer directly).
        frontendWarn("log_viewer", `loading buffered backend logs failed: ${errorMessage(err)}`);
      });

    const unsubBackend = subscribeGuarded(
      () =>
        onLogEntry((entry) => {
          if (!isOwnEcho(entry)) addEntry(entry);
        }),
      "log_viewer",
      "backend log events"
    );

    return () => {
      cancelled = true;
      unsubBackend();
      unsubFrontend();
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
      clearFrontendLogHistory();
      setEntries([]);
    } catch (err) {
      toast.error("Could not clear logs", { description: errorMessage(err) });
    }
  }, []);

  const handleSave = useCallback(async (entriesToSave: LogEntry[]) => {
    try {
      // Redact secrets before the logs leave the app — a user saving logs to
      // attach to a bug report must not leak passwords/tokens/keys (OBS-008).
      const content = redactLogText(entriesToSave.map(formatEntry).join("\n"));
      const filePath = await save({
        title: "Save logs",
        defaultPath: "termihub-logs.txt",
        filters: [{ name: "Text", extensions: ["txt", "log"] }],
      });
      if (!filePath) return;
      await writeTextFile(filePath, content);
      toast.success("Logs saved", { description: filePath });
    } catch (err) {
      // A cancelled dialog resolves to null above; reaching here is a real failure.
      reportFailure("Could not save logs", "save logs", err);
    }
  }, []);

  const handleCopyEntry = useCallback(async (entry: LogEntry) => {
    try {
      // Redact secrets before copying to the clipboard (OBS-008). The Tauri
      // clipboard plugin, not navigator.clipboard, which rejects on
      // macOS/WKWebView when the window is not focused (#4327).
      await writeText(redactLogText(formatEntry(entry)));
      toast.success("Log entry copied");
    } catch (err) {
      reportFailure("Could not copy log entry", "copy log entry", err);
    }
  }, []);

  const handleCopyAll = useCallback(async (entriesToCopy: LogEntry[]) => {
    try {
      // Redact secrets before copying to the clipboard (OBS-008).
      const content = redactLogText(entriesToCopy.map(formatEntry).join("\n"));
      await writeText(content);
      const count = entriesToCopy.length;
      toast.success("Logs copied", {
        description: `${count} ${count === 1 ? "entry" : "entries"}`,
      });
    } catch (err) {
      reportFailure("Could not copy logs", "copy logs", err);
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
              className={`log-viewer__level-filter log-viewer__level-filter--${level.toLowerCase()} ${
                activeLevels.has(level) ? "log-viewer__level-filter--active" : ""
              }`}
              onClick={() => toggleLevel(level)}
              title={`Toggle ${level} logs`}
            >
              {level}
            </button>
          ))}
        </div>
        <SearchInput
          className="log-viewer__search"
          size="sm"
          placeholder="Search logs..."
          aria-label="Search logs"
          value={search}
          onValueChange={setSearch}
          clearLabel="Clear log search"
        />
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          className={autoScroll ? "log-viewer__toolbar-action--active" : undefined}
          icon={autoScroll ? <Pause size={14} /> : <Play size={14} />}
          onClick={() => setAutoScroll((v) => !v)}
          title={autoScroll ? "Pause auto-scroll" : "Resume auto-scroll"}
        />
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon={<Save size={14} />}
          onClick={() => handleSave(filteredEntries)}
          title="Save logs to file"
        />
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon={<Trash2 size={14} />}
          onClick={handleClear}
          title="Clear logs"
        />
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
                  <span className="log-viewer__target">{displayTarget(entry)}</span>
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
                  <ContextMenu.Item
                    className="context-menu__item"
                    onSelect={() => handleCopyAll(filteredEntries)}
                  >
                    <ClipboardCopy size={14} /> Copy All Logs
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

/** Surface a failed export action as a toast and an ERROR entry in this log (OBS2-006). */
function reportFailure(title: string, action: string, err: unknown): void {
  const message = errorMessage(err);
  frontendError("log_viewer", `${action} failed: ${message}`);
  toast.error(title, { description: message });
}

function entryMatchesSearch(entry: LogEntry, searchLower: string): boolean {
  return (
    entry.message.toLowerCase().includes(searchLower) ||
    displayTarget(entry).toLowerCase().includes(searchLower) ||
    entry.level.toLowerCase().includes(searchLower)
  );
}

function formatEntry(entry: LogEntry): string {
  return `${entry.timestamp} [${entry.level}] ${displayTarget(entry)}: ${entry.message}`;
}
