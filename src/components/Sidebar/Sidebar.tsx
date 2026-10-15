import { useAppStore } from "@/store/appStore";
import { ConnectionList } from "./ConnectionList";
import { FileBrowser } from "./FileBrowser";
import { TunnelSidebar } from "@/components/TunnelSidebar";
import { WorkspaceSidebar } from "@/components/WorkspaceSidebar";
import { MacroSidebar } from "@/components/MacroSidebar";
import { RecentSessionsSidebar } from "@/components/RecentSessionsSidebar";
import { WorkflowSidebar } from "@/components/WorkflowSidebar";
import { NetworkToolsSidebar } from "@/components/NetworkTools/NetworkToolsSidebar";
import { EmbeddedServerSidebar } from "@/components/EmbeddedServerSidebar";
import { PluginManagerView } from "@/components/Plugins";
import "./Sidebar.css";

const VIEW_TITLES: Record<string, string> = {
  connections: "Connections",
  files: "File Browser",
  tunnels: "SSH Tunnels",
  services: "Services",
  workspaces: "Workspaces",
  macros: "Macros",
  workflows: "Workflows",
  "network-tools": "Network Tools",
  "recent-sessions": "Recent Sessions",
  plugins: "Plugins",
};

interface SidebarProps {
  width?: number;
}

export function Sidebar({ width }: SidebarProps) {
  const sidebarView = useAppStore((s) => s.sidebarView);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);

  if (sidebarCollapsed) return null;

  return (
    // Complementary landmark named after the active view (A11Y2-012).
    <aside
      className="sidebar"
      data-testid="sidebar"
      aria-label={VIEW_TITLES[sidebarView] ?? "Sidebar"}
      style={width != null ? { width } : undefined}
    >
      <div className="sidebar__header">
        <span className="sidebar__title">{VIEW_TITLES[sidebarView]}</span>
      </div>
      <div className="sidebar__content">
        {sidebarView === "connections" && <ConnectionList />}
        {sidebarView === "files" && <FileBrowser />}
        {sidebarView === "tunnels" && <TunnelSidebar />}
        {sidebarView === "services" && <EmbeddedServerSidebar />}
        {sidebarView === "workspaces" && <WorkspaceSidebar />}
        {sidebarView === "macros" && <MacroSidebar />}
        {sidebarView === "recent-sessions" && <RecentSessionsSidebar />}
        {sidebarView === "workflows" && <WorkflowSidebar />}
        {sidebarView === "network-tools" && <NetworkToolsSidebar />}
        {sidebarView === "plugins" && <PluginManagerView />}
      </div>
    </aside>
  );
}
