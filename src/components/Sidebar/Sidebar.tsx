import { useAppStore } from "@/store/appStore";
import { ConnectionList } from "./ConnectionList";
import { FileBrowser } from "./FileBrowser";
import { TunnelSidebar } from "@/components/TunnelSidebar";
import "./Sidebar.css";

const VIEW_TITLES: Record<string, string> = {
  connections: "Connections",
  files: "File Browser",
  tunnels: "SSH Tunnels",
};

interface SidebarProps {
  width?: number;
}

export function Sidebar({ width }: SidebarProps) {
  const sidebarView = useAppStore((s) => s.sidebarView);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);

  if (sidebarCollapsed) return null;

  return (
    <div className="sidebar" data-testid="sidebar" style={width != null ? { width } : undefined}>
      <div className="sidebar__header">
        <span className="sidebar__title">{VIEW_TITLES[sidebarView]}</span>
      </div>
      <div className="sidebar__content">
        {sidebarView === "connections" && <ConnectionList />}
        {sidebarView === "files" && <FileBrowser />}
        {sidebarView === "tunnels" && <TunnelSidebar />}
      </div>
    </div>
  );
}
