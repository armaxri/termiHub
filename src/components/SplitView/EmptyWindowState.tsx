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
import { ICON_SIZE } from "@/components/ui/iconSize";
import "./EmptyWindowState.css";

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
 */
export function EmptyWindowState() {
  const addLocalShellTab = useAppStore((s) => s.addLocalShellTab);
  const openConnectionEditorTab = useAppStore((s) => s.openConnectionEditorTab);
  const sessionHistory = useAppStore((s) => s.sessionHistory);
  const { connections } = useProjectedConnections();
  const { count: windowCount } = useWindowInfo();
  const [restoreOpen, setRestoreOpen] = useState(false);
  const recentLabelId = useId();

  const hasConnections = connections.length > 0;
  const multiWindow = windowCount > 1;
  const recent = pickRecentConnections(connections, sessionHistory);

  return (
    <div className="empty-window" data-testid="empty-window-state">
      <EmptyState
        variant="card"
        role={undefined}
        icon={<AppWindow size={ICON_SIZE.xl} strokeWidth={1.5} />}
        title="This window is empty"
        description={
          <>
            {hasConnections
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
                icon={<Plus size={ICON_SIZE.sm} />}
                onClick={() => {
                  addLocalShellTab();
                }}
                data-testid="empty-window-new-terminal"
              >
                New terminal
              </Button>
              {!hasConnections && (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Network size={ICON_SIZE.sm} />}
                    onClick={() => openConnectionEditorTab("new")}
                    data-testid="empty-window-new-connection"
                  >
                    New connection
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Upload size={ICON_SIZE.sm} />}
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
                {recent.connections.map((connection) => (
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
                        size={ICON_SIZE.sm}
                      />
                    }
                    onClick={() => void connectSavedConnection(connection)}
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
      {!hasConnections && <BackupRestoreDialog open={restoreOpen} onOpenChange={setRestoreOpen} />}
    </div>
  );
}
