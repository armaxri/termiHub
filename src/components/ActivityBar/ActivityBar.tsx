import { useCallback } from "react";
import { Network, FolderOpen, Activity, Settings, Download, Upload } from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { save, open } from "@tauri-apps/plugin-dialog";
import { writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";
import { exportConnections, importConnections } from "@/services/storage";
import { useAppStore, SidebarView } from "@/store/appStore";
import { ActivityBarItem } from "./ActivityBarItem";
import "./ActivityBar.css";

const TOP_ITEMS: { view: SidebarView; icon: typeof Network; label: string }[] = [
  { view: "connections", icon: Network, label: "Connections" },
  { view: "files", icon: FolderOpen, label: "File Browser" },
  { view: "monitoring", icon: Activity, label: "Monitoring" },
];

export function ActivityBar() {
  const sidebarView = useAppStore((s) => s.sidebarView);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const setSidebarView = useAppStore((s) => s.setSidebarView);
  const openSettingsTab = useAppStore((s) => s.openSettingsTab);
  const loadFromBackend = useAppStore((s) => s.loadFromBackend);

  const handleExport = useCallback(async () => {
    try {
      const json = await exportConnections();
      const filePath = await save({
        defaultPath: "termihub-connections.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!filePath) return;
      await writeTextFile(filePath, json);
    } catch (err) {
      console.error("Failed to export connections:", err);
    }
  }, []);

  const handleImport = useCallback(async () => {
    try {
      const filePath = await open({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!filePath) return;
      const json = await readTextFile(filePath);
      await importConnections(json);
      await loadFromBackend();
    } catch (err) {
      console.error("Failed to import connections:", err);
    }
  }, [loadFromBackend]);

  return (
    <div className="activity-bar">
      <div className="activity-bar__top">
        {TOP_ITEMS.map((item) => (
          <ActivityBarItem
            key={item.view}
            icon={item.icon}
            label={item.label}
            isActive={sidebarView === item.view && !sidebarCollapsed}
            onClick={() => setSidebarView(item.view)}
          />
        ))}
      </div>
      <div className="activity-bar__bottom">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              className="activity-bar__item"
              title="Settings"
              aria-label="Settings"
              data-testid="activity-bar-settings"
            >
              <Settings size={24} strokeWidth={1.5} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className="settings-menu__content"
              side="right"
              align="end"
              sideOffset={4}
            >
              <DropdownMenu.Item
                className="settings-menu__item"
                onSelect={openSettingsTab}
                data-testid="settings-menu-open"
              >
                <Settings size={14} />
                Settings
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="settings-menu__separator" />
              <DropdownMenu.Item
                className="settings-menu__item"
                onSelect={handleImport}
                data-testid="settings-menu-import"
              >
                <Upload size={14} />
                Import Connections
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className="settings-menu__item"
                onSelect={handleExport}
                data-testid="settings-menu-export"
              >
                <Download size={14} />
                Export Connections
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </div>
  );
}
