import { useCallback, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { writeText as writeClipboard } from "@tauri-apps/plugin-clipboard-manager";
import { useAppStore } from "@/store/appStore";
import { Button, ConfirmDialog, Input, Tooltip, toast } from "@/components/ui";
import { useConnectSavedConnection } from "@/hooks/useConnectSavedConnection";
import { useFlatRovingNav } from "@/hooks/useFlatRovingNav";
import type { ConnectionConfig } from "@/types/terminal";
import type { SavedConnection } from "@/types/connection";
import type { SessionHistoryEntry } from "@/types/sessionHistory";
import { QuickConnectBar } from "./QuickConnectBar";
import { RecentSessionItem } from "./RecentSessionItem";
import { SaveAsConnectionDialog } from "./SaveAsConnectionDialog";
import { connectionString } from "./connectionString";
import "./RecentSessionsSidebar.css";

/** True when the entry matches the (already lower-cased) query. */
function entryMatches(entry: SessionHistoryEntry, query: string): boolean {
  if (!query) return true;
  return (
    entry.title.toLowerCase().includes(query) ||
    entry.dedupKey.toLowerCase().includes(query) ||
    entry.connectionType.toLowerCase().includes(query)
  );
}

/**
 * The "Recent Sessions" panel: a quick-connect bar plus a searchable,
 * pinnable list of automatically recorded sessions. Rows reconnect on
 * double-click and expose pin / save-as-connection / copy / remove actions.
 * Recording, deduplication, and eviction live in the store + backend; this
 * panel is the browse-and-reconnect surface.
 */
export function RecentSessionsSidebar() {
  const history = useAppStore((s) => s.sessionHistory);
  const folders = useAppStore((s) => s.folders);
  const defaultUser = useAppStore((s) => s.settings.defaultUser);
  const addConnection = useAppStore((s) => s.addConnection);
  const pinHistoryEntry = useAppStore((s) => s.pinHistoryEntry);
  const removeHistoryEntry = useAppStore((s) => s.removeHistoryEntry);
  const clearSessionHistory = useAppStore((s) => s.clearSessionHistory);
  const markHistoryPromoted = useAppStore((s) => s.markHistoryPromoted);
  const splitPanel = useAppStore((s) => s.splitPanel);
  const { connect } = useConnectSavedConnection();

  const [query, setQuery] = useState("");
  const [saveEntry, setSaveEntry] = useState<SessionHistoryEntry | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return history.filter((e) => entryMatches(e, q));
  }, [history, query]);

  // Reconnect by reusing the credential-aware saved-connection flow with a
  // synthetic (unsaved) connection: SSH password/passphrase prompts and stored
  // credentials work exactly as they do from the Connections tree.
  const openConnection = useCallback(
    async (config: ConnectionConfig, name: string) => {
      const synthetic: SavedConnection = { id: "", name, config, folderId: null };
      try {
        await connect(synthetic);
      } catch (err) {
        toast.error(`Failed to connect: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [connect]
  );

  const handleConnect = useCallback(
    (entry: SessionHistoryEntry) => void openConnection(entry.config, entry.title),
    [openConnection]
  );

  // Split the active panel first, then connect: the freshly created panel
  // becomes active, so the shared connect flow opens its tab there instead of
  // the current panel.
  const handleConnectInNewPanel = useCallback(
    (entry: SessionHistoryEntry) => {
      splitPanel();
      void openConnection(entry.config, entry.title);
    },
    [splitPanel, openConnection]
  );

  const handleTogglePin = useCallback(
    (entry: SessionHistoryEntry) => {
      void pinHistoryEntry(entry.dedupKey, !entry.pinned).catch((err) => {
        toast.error(`Failed to update pin: ${err instanceof Error ? err.message : String(err)}`);
      });
    },
    [pinHistoryEntry]
  );

  const handleRemove = useCallback(
    (entry: SessionHistoryEntry) => {
      void removeHistoryEntry(entry.dedupKey)
        .then(() => toast.success(`Removed “${entry.title}” from history`))
        .catch((err) => {
          toast.error(
            `Failed to remove entry: ${err instanceof Error ? err.message : String(err)}`
          );
        });
    },
    [removeHistoryEntry]
  );

  const handleCopyString = useCallback((entry: SessionHistoryEntry) => {
    const text = connectionString(entry);
    writeClipboard(text)
      .then(() => toast.success("Copied connection string"))
      .catch(() => toast.error("Failed to copy connection string"));
  }, []);

  const handleSaveConnection = useCallback(
    async (connection: SavedConnection, dedupKey: string) => {
      addConnection(connection);
      await markHistoryPromoted(dedupKey).catch(() => {});
    },
    [addConnection, markHistoryPromoted]
  );

  const handleConfirmClear = useCallback(() => {
    setConfirmClear(false);
    void clearSessionHistory()
      .then(() => toast.success("Cleared session history"))
      .catch((err) => {
        toast.error(`Failed to clear history: ${err instanceof Error ? err.message : String(err)}`);
      });
  }, [clearSessionHistory]);

  const handleActivate = useCallback(
    (entry: SessionHistoryEntry) => handleConnect(entry),
    [handleConnect]
  );
  const nav = useFlatRovingNav<SessionHistoryEntry, HTMLDivElement>(
    filtered,
    (entry) => entry.dedupKey,
    handleActivate
  );

  return (
    <div className="recent-sessions" data-testid="recent-sessions-sidebar">
      <QuickConnectBar history={history} defaultUser={defaultUser} onConnect={openConnection} />
      <div className="recent-sessions__actions">
        <Tooltip content="Clear all history" side="top">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<Trash2 size={14} />}
            onClick={() => setConfirmClear(true)}
            disabled={history.length === 0}
            aria-label="Clear all history"
            data-testid="recent-sessions-clear"
          />
        </Tooltip>
      </div>
      {history.length > 0 && (
        <div className="recent-sessions__search">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search history"
            aria-label="Search history"
            data-testid="recent-sessions-search"
          />
        </div>
      )}
      {history.length === 0 ? (
        <div className="recent-sessions__empty" data-testid="recent-sessions-empty">
          <span>No recent sessions yet.</span>
          <span>Connect to a host and it will appear here for quick reconnection.</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="recent-sessions__empty" data-testid="recent-sessions-no-results">
          <span>No sessions match &quot;{query}&quot;.</span>
        </div>
      ) : (
        <div
          className="recent-sessions__list"
          data-testid="recent-sessions-list"
          role="tree"
          aria-label="Recent sessions"
          onKeyDown={nav.onKeyDown}
        >
          {filtered.map((entry, index) => {
            const { ref, ...itemProps } = nav.getItemProps(index);
            return (
              <RecentSessionItem
                key={entry.dedupKey}
                entry={entry}
                onConnect={handleConnect}
                onConnectInNewPanel={handleConnectInNewPanel}
                onTogglePin={handleTogglePin}
                onSaveAsConnection={setSaveEntry}
                onCopyString={handleCopyString}
                onRemove={handleRemove}
                rowRef={ref}
                rowProps={itemProps}
              />
            );
          })}
        </div>
      )}
      <SaveAsConnectionDialog
        entry={saveEntry}
        folders={folders}
        onOpenChange={(open) => {
          if (!open) setSaveEntry(null);
        }}
        onSave={handleSaveConnection}
      />
      <ConfirmDialog
        open={confirmClear}
        title="Clear session history"
        message="Remove all recorded sessions? Pinned entries are removed too. This cannot be undone."
        confirmLabel="Clear History"
        onConfirm={handleConfirmClear}
        onCancel={() => setConfirmClear(false)}
      />
    </div>
  );
}
