import { useId, useState } from "react";
import { AppWindow, Plus, Network, Upload } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useProjectedConnections } from "@/store/useProjectedConnections";
import { useWindowInfo } from "@/hooks/useWindowInfo";
import { Button, EmptyState } from "@/components/ui";
import { BackupRestoreDialog } from "@/components/Settings/BackupRestoreDialog";
import { ConnectionIcon } from "@/utils/connectionIcons";
import { connectSavedConnection } from "@/utils/connectSavedConnection";
import { pickRecentConnections } from "@/utils/recentConnections";
import "./EmptyWindowState.css";

/** How many connections the compact state of an empty panel lists. */
const COMPACT_RECENT = 3;

/** Props of {@link EmptyWindowState}. */
export interface EmptyWindowStateProps {
  /** The empty panel of a split it stands in (#6162); none for an empty window. */
  panelId?: string;
}

/**
 * First-class empty-window call-to-action (#1902, epic #1899; onboarding UX-003).
 *
 * A native window can exist with **zero tabs** — right after *New Window*, or
 * after its last tab is moved or closed. Rather than an accidental blank pane,
 * the content area shows a deliberate CTA so the window is immediately useful:
 * start a local shell here, or reach a saved connection from this window. The
 * activity bar and sidebar stay mounted (they live outside this component), so a
 * connection can be launched straight into the empty window.
 *
 * Because this is also the closest thing to a first-run screen, the actions
 * adapt to what the user actually has (#5856):
 *
 * - **≥1 saved connection:** up to five of them, most recently opened first,
 *   as one-click buttons that connect exactly like the sidebar. No generic
 *   "Open connection…" and no "New connection" (the sidebar has one, R-107).
 * - **No saved connection** (a fresh or wiped profile): "New connection" and
 *   "Restore from backup…", so someone starting over sees that a restore is
 *   possible from here (R-085).
 *
 * The power-user "Move to window" hint is shown only when more than one window
 * is actually open.
 *
 * Rendered by {@link SplitView} in place of the tab-group/tab-bar tree while the
 * window holds no tabs; every action runs against *this* window's store, so a
 * launched session (or a tab moved in via "Move to window") replaces the CTA
 * with the normal tab UI.
 *
 * With `panelId` it is the compact state of one empty panel in a split (#6162):
 * the same next steps, a new terminal or a recent connection, opened in that
 * panel; the window-level hints (restore, new connection, move a tab in) stay
 * with the empty window.
 */
export function EmptyWindowState({ panelId }: EmptyWindowStateProps = {}) {
  const addLocalShellTab = useAppStore((s) => s.addLocalShellTab);
  const setActivePanel = useAppStore((s) => s.setActivePanel);
  const openConnectionEditorTab = useAppStore((s) => s.openConnectionEditorTab);
  const sessionHistory = useAppStore((s) => s.sessionHistory);
  const { connections } = useProjectedConnections();
  const { count: windowCount } = useWindowInfo();
  const [restoreOpen, setRestoreOpen] = useState(false);
  const recentLabelId = useId();

  const compact = panelId !== undefined;
  const hasConnections = connections.length > 0;
  const multiWindow = !compact && windowCount > 1;
  const recent = pickRecentConnections(connections, sessionHistory);
  const shown = compact ? recent.connections.slice(0, COMPACT_RECENT) : recent.connections;
  // Whatever starts here opens in this panel.
  const here = () => {
    if (panelId !== undefined) setActivePanel(panelId);
  };

  return (
    <div
      className={compact ? "empty-window empty-window--compact" : "empty-window"}
      data-testid={compact ? "empty-panel-state" : "empty-window-state"}
    >
      <EmptyState
        variant="card"
        role={undefined}
        icon={compact ? undefined : <AppWindow size={28} strokeWidth={1.5} />}
        title={compact ? "This panel is empty" : "This window is empty"}
        description={
          <>
            {compact
              ? hasConnections
                ? "Start a local terminal here, or open one of your connections."
                : "Start a local terminal here."
              : hasConnections
                ? "Start a local terminal, or open one of your connections."
                : "Start a local terminal, create a connection, or restore your data from a backup."}
            {multiWindow && (
              <>
                {" "}
                You can also move a tab in from another window with{" "}
                <strong>Tab ▸ Move to window</strong>.
              </>
            )}
          </>
        }
        action={
          <div className="empty-window__actions">
            <div className="empty-window__row">
              <Button
                variant="primary"
                size="sm"
                icon={<Plus size={14} />}
                onClick={() => {
                  if (panelId !== undefined) addLocalShellTab({ panelId });
                  else addLocalShellTab();
                }}
                data-testid="empty-window-new-terminal"
              >
                New terminal
              </Button>
              {!hasConnections && !compact && (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Network size={14} />}
                    onClick={() => openConnectionEditorTab("new")}
                    data-testid="empty-window-new-connection"
                  >
                    New connection
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Upload size={14} />}
                    onClick={() => setRestoreOpen(true)}
                    data-testid="empty-window-restore"
                  >
                    Restore from backup…
                  </Button>
                </>
              )}
            </div>
            {hasConnections && (
              <div
                className="empty-window__recent"
                role="group"
                aria-labelledby={recentLabelId}
                data-testid="empty-window-recent"
              >
                <p id={recentLabelId} className="empty-window__recent-label">
                  {recent.fromHistory ? "Recent connections" : "Your connections"}
                </p>
                {shown.map((connection) => (
                  <Button
                    key={connection.id}
                    variant="ghost"
                    size="sm"
                    fullWidth
                    className="empty-window__recent-item"
                    icon={
                      <ConnectionIcon
                        config={connection.config}
                        customIcon={connection.icon}
                        iconColor={connection.iconColor}
                        iconEmoji={connection.iconEmoji}
                        size={14}
                      />
                    }
                    onClick={() => {
                      here();
                      void connectSavedConnection(connection);
                    }}
                    data-testid={`empty-window-recent-${connection.id}`}
                  >
                    {connection.name}
                  </Button>
                ))}
              </div>
            )}
          </div>
        }
      />
      {!hasConnections && !compact && (
        <BackupRestoreDialog open={restoreOpen} onOpenChange={setRestoreOpen} />
      )}
    </div>
  );
}
