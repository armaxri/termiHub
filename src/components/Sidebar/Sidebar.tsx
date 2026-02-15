import { useAppStore } from "@/store/appStore";
import { ConnectionList } from "./ConnectionList";
import { FileBrowser } from "./FileBrowser";
import { MonitoringPanel } from "./MonitoringPanel";
import "./Sidebar.css";

const VIEW_TITLES: Record<string, string> = {
  connections: "Connections",
  files: "File Browser",
  monitoring: "Monitoring",
};

export function Sidebar() {
  const sidebarView = useAppStore((s) => s.sidebarView);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);

  if (sidebarCollapsed) return null;

  return (
    <div className="sidebar">
      <div className="sidebar__header">
        <span className="sidebar__title">{VIEW_TITLES[sidebarView]}</span>
      </div>
      <div className="sidebar__content">
        {sidebarView === "connections" && <ConnectionList />}
        {sidebarView === "files" && <FileBrowser />}
        {sidebarView === "monitoring" && <MonitoringPanel />}
      </div>
    </div>
  );
}
