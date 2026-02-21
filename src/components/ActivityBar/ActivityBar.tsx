import { useCallback } from "react";
import {
  Network,
  FolderOpen,
  ArrowLeftRight,
  Settings,
  Download,
  Upload,
  ScrollText,
  LayoutDashboard,
} from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { useAppStore, SidebarView } from "@/store/appStore";
import { ActivityBarItem } from "./ActivityBarItem";
import "./ActivityBar.css";

const TOP_ITEMS: { view: SidebarView; icon: typeof Network; label: string }[] = [
  { view: "connections", icon: Network, label: "Connections" },
  { view: "files", icon: FolderOpen, label: "File Browser" },
  { view: "tunnels", icon: ArrowLeftRight, label: "SSH Tunnels" },
];

interface ActivityBarProps {
  horizontal?: boolean;
}

export function ActivityBar({ horizontal }: ActivityBarProps) {
  const sidebarView = useAppStore((s) => s.sidebarView);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const setSidebarView = useAppStore((s) => s.setSidebarView);
  const openSettingsTab = useAppStore((s) => s.openSettingsTab);
  const openLogViewerTab = useAppStore((s) => s.openLogViewerTab);
  const activityBarPosition = useAppStore((s) => s.layoutConfig.activityBarPosition);
  const setLayoutDialogOpen = useAppStore((s) => s.setLayoutDialogOpen);
  const setExportDialogOpen = useAppStore((s) => s.setExportDialogOpen);
  const setImportDialog = useAppStore((s) => s.setImportDialog);

  const handleExport = useCallback(() => {
    setExportDialogOpen(true);
  }, [setExportDialogOpen]);

  const handleImport = useCallback(async () => {
    try {
      const filePath = await open({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!filePath) return;
      const json = await readTextFile(filePath);
      setImportDialog(true, json);
    } catch (err) {
      console.error("Failed to read import file:", err);
    }
  }, [setImportDialog]);

  return (
    <div
      className={`activity-bar${activityBarPosition === "right" ? " activity-bar--right" : ""}${horizontal ? " activity-bar--horizontal" : ""}`}
    >
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
        <button
          className="activity-bar__item"
          title="Log Viewer"
          aria-label="Log Viewer"
          data-testid="activity-bar-logs"
          onClick={openLogViewerTab}
        >
          <ScrollText size={24} strokeWidth={1.5} />
        </button>
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
              side={horizontal ? "bottom" : "right"}
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
              <DropdownMenu.Item
                className="settings-menu__item"
                onSelect={() => setLayoutDialogOpen(true)}
                data-testid="settings-menu-customize-layout"
              >
                <LayoutDashboard size={14} />
                Customize Layout...
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
