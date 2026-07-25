import { AppWindow, Plus, Network } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { Button } from "@/components/ui";
import "./EmptyWindowState.css";

/**
 * First-class empty-window call-to-action (#1902, epic #1899).
 *
 * A native window can exist with **zero tabs** — right after *New Window*, or
 * after its last tab is moved or closed. Rather than an accidental blank pane,
 * the content area shows a deliberate CTA so the window is immediately useful:
 * start a local shell here, or open a saved connection into this window. The
 * activity bar and sidebar stay mounted (they live outside this component), so a
 * connection can be launched straight into the empty window.
 *
 * Rendered by {@link SplitView} in place of the tab-group/tab-bar tree while the
 * window holds no tabs; both actions run against *this* window's store, so a
 * launched session (or a tab moved in via "Move to Window") replaces the CTA
 * with the normal tab UI.
 */
export function EmptyWindowState() {
  const addTab = useAppStore((s) => s.addTab);

  /** Launch a local shell into this window. */
  const handleNewTerminal = () => {
    addTab("Terminal", "local");
  };

  /** Reveal the Connections sidebar so a saved connection can be opened here. */
  const handleOpenConnection = () => {
    const { sidebarView, sidebarCollapsed, setSidebarView } = useAppStore.getState();
    // setSidebarView toggles the sidebar closed when the view is already the
    // active, expanded one — so only call it when it would actually reveal the
    // Connections panel rather than collapse it.
    if (sidebarView !== "connections" || sidebarCollapsed) {
      setSidebarView("connections");
    }
  };

  return (
    <div className="empty-window" data-testid="empty-window-state">
      <div className="empty-window__card">
        <div className="empty-window__icon">
          <AppWindow size={28} strokeWidth={1.5} />
        </div>
        <p className="empty-window__title">This window is empty</p>
        <p className="empty-window__sub">
          Start a session here, or move a tab in from another window with{" "}
          <strong>Tab ▸ Move to Window</strong>.
        </p>
        <div className="empty-window__actions">
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
        </div>
      </div>
    </div>
  );
}
