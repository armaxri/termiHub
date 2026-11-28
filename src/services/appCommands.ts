/**
 * Palette commands without a key binding (#6158): the gear menu's items, the
 * activity bar's views and New connection…, so everything the gear menu and
 * the activity bar reach can be found and run from the palette.
 *
 * Settings and Keyboard shortcuts are left out here: their key-bound commands
 * already offer them. So is Services, which has its own "Show services".
 */
import {
  Activity,
  FileArchive,
  FileText,
  Info,
  LayoutDashboard,
  Plus,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import { openDiagnosticsExport } from "@/components/Diagnostics/diagnosticsDialogStore";
import { useServicesView } from "@/components/ServicesSidebar/servicesView";
import {
  OPTIONAL_ITEMS,
  REQUIRED_ITEMS,
  isViewOffBySetting,
} from "@/components/ActivityBar/activityBarItems";
import { useAppStore } from "@/store/appStore";
import { currentSettingsView } from "@/store/settingsBridge";

/** A palette command that has no key binding. */
export interface AppCommand {
  id: string;
  label: string;
  icon: LucideIcon;
  run: () => void;
}

/** The views whose key-bound command already shows them. */
const VIEWS_WITH_THEIR_OWN_COMMAND = new Set<string>(["services"]);

/** The gear menu's items that have no key binding, in its order. */
function gearCommands(): AppCommand[] {
  const store = () => useAppStore.getState();
  return [
    {
      id: "customize-layout",
      label: "Customize layout…",
      icon: LayoutDashboard,
      run: () => store().setLayoutDialogOpen(true),
    },
    {
      id: "open-connections",
      label: "Open connections",
      icon: Activity,
      run: () => useServicesView.getState().setOpenConnections(true),
    },
    {
      id: "updates",
      label: "Updates",
      icon: RefreshCw,
      run: () => store().openOverlayView("updates"),
    },
    {
      id: "export-diagnostics",
      label: "Export diagnostics…",
      icon: FileArchive,
      run: () => openDiagnosticsExport(),
    },
    {
      id: "about",
      label: "About termiHub",
      icon: Info,
      run: () => store().openOverlayView("about"),
    },
    {
      id: "log-viewer",
      label: "Log viewer",
      icon: FileText,
      run: () => store().openLogViewerTab(),
    },
  ];
}

/** "Show …" for each activity bar view a setting has not turned off. */
function viewCommands(): AppCommand[] {
  const settings = currentSettingsView();
  return [...REQUIRED_ITEMS, ...OPTIONAL_ITEMS]
    .filter((item) => !VIEWS_WITH_THEIR_OWN_COMMAND.has(item.view))
    .filter((item) => !isViewOffBySetting(item.view, settings))
    .map((item) => ({
      id: `show-view-${item.view}`,
      label: `Show ${item.label.toLowerCase()}`,
      icon: item.icon,
      run: () => useAppStore.getState().setSidebarView(item.view),
    }));
}

/** Every palette command without a key binding. */
export function buildAppCommands(): AppCommand[] {
  return [
    {
      id: "new-connection",
      label: "New connection…",
      icon: Plus,
      run: () => useAppStore.getState().openConnectionEditorTab("new"),
    },
    ...viewCommands(),
    ...gearCommands(),
  ];
}
