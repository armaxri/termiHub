import { AppWindow, Plus, Network } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useProjectedConnections } from "@/store/useProjectedConnections";
import { useWindowInfo } from "@/hooks/useWindowInfo";
import { Button, EmptyState } from "@/components/ui";
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
 * Because this is also the closest thing to a first-run screen, the secondary
 * CTA adapts to what the user actually has: with **≥1 saved connection** it opens
 * the command palette so they can fuzzy-find and connect one (reusing the
 * sidebar's exact connect/credential flow); with **zero connections** it routes
 * straight to the new-connection editor rather than dead-ending on a blank
 * Connections panel. The copy likewise speaks to a first-run user, and the
 * power-user "Move to Window" hint is shown only when more than one window is
 * actually open.
 *
 * Rendered by {@link SplitView} in place of the tab-group/tab-bar tree while the
 * window holds no tabs; both actions run against *this* window's store, so a
 * launched session (or a tab moved in via "Move to Window") replaces the CTA
 * with the normal tab UI.
 */
export function EmptyWindowState() {
  const addTab = useAppStore((s) => s.addTab);
  const openConnectionEditorTab = useAppStore((s) => s.openConnectionEditorTab);
  const setCommandPaletteOpen = useAppStore((s) => s.setCommandPaletteOpen);
  const { connections } = useProjectedConnections();
  const { count: windowCount } = useWindowInfo();

  const hasConnections = connections.length > 0;
  const multiWindow = windowCount > 1;

  /** Launch a local shell into this window. */
  const handleNewTerminal = () => {
    addTab("Terminal", "local");
  };

  /**
   * Get the user to a connection from an empty window. With saved connections
   * present, open the command palette (its ranked list includes every saved
   * connection); with none, open the new-connection editor so a first-run user
   * lands on the create flow instead of a blank Connections panel.
   */
  const handleOpenConnection = () => {
    if (hasConnections) {
      setCommandPaletteOpen(true);
    } else {
      openConnectionEditorTab("new");
    }
  };

  return (
    <div className="empty-window" data-testid="empty-window-state">
      <EmptyState
        variant="card"
        role={undefined}
        icon={<AppWindow size={28} strokeWidth={1.5} />}
        title="This window is empty"
        description={
          <>
            Start a local terminal now, or{" "}
            {hasConnections
              ? "open a saved connection"
              : "create a connection to save it for next time"}
            .
            {multiWindow && (
              <>
                {" "}
                You can also move a tab in from another window with{" "}
                <strong>Tab ▸ Move to Window</strong>.
              </>
            )}
          </>
        }
        action={
          <>
            <Button
              variant="primary"
              size="sm"
              icon={<Plus size={14} />}
              onClick={handleNewTerminal}
              data-testid="empty-window-new-terminal"
            >
              New Terminal
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Network size={14} />}
              onClick={handleOpenConnection}
              data-testid="empty-window-open-connection"
            >
              Open Connection…
            </Button>
          </>
        }
      />
    </div>
  );
}
