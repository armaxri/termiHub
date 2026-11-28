import { useAppStore } from "@/store/appStore";
import { ConnectionList } from "./ConnectionList";
import { FileBrowser } from "./FileBrowser";
import { WorkspaceSidebar } from "@/components/WorkspaceSidebar";
import { AutomationSidebar } from "@/components/AutomationSidebar";
import { RecentSessionsSidebar } from "@/components/RecentSessionsSidebar";
import { NetworkToolsSidebar } from "@/components/NetworkTools/NetworkToolsSidebar";
import { ServicesSidebar } from "@/components/ServicesSidebar";
import { PluginManagerView } from "@/components/Plugins";
import "./Sidebar.css";

const VIEW_TITLES: Record<string, string> = {
  connections: "Connections",
  files: "File browser",
  services: "Services",
  workspaces: "Workspaces",
  automations: "Automations",
  "network-tools": "Network tools",
  "recent-sessions": "Recent sessions",
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
        <span className="ui-section-label sidebar__title" data-testid="sidebar-title">
          {VIEW_TITLES[sidebarView]}
        </span>
      </div>
      <div className="sidebar__content">
        {sidebarView === "connections" && <ConnectionList />}
        {sidebarView === "files" && <FileBrowser />}
        {sidebarView === "services" && <ServicesSidebar />}
        {sidebarView === "workspaces" && <WorkspaceSidebar />}
        {sidebarView === "automations" && <AutomationSidebar />}
        {sidebarView === "recent-sessions" && <RecentSessionsSidebar />}
        {sidebarView === "network-tools" && <NetworkToolsSidebar />}
        {sidebarView === "plugins" && <PluginManagerView />}
      </div>
    </aside>
  );
}
