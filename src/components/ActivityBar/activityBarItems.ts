/**
 * The activity bar's views (#5848): one list for the bar and the command
 * palette's "Show …" commands (#6158), so both offer the same views with the
 * same icon and label.
 */
import {
  FolderOpen,
  History,
  LayoutGrid,
  Network,
  Puzzle,
  Server,
  Stethoscope,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { SidebarView } from "@/store/appStore";

/** One view of the activity bar. */
export interface ActivityBarItemDef {
  view: SidebarView;
  icon: LucideIcon;
  /** The glyph's lucide name, exposed as `data-icon` for the product-run grade (#5848). */
  iconName: string;
  label: string;
}

/** Views that are always there. */
export const REQUIRED_ITEMS: ActivityBarItemDef[] = [
  { view: "connections", icon: Network, iconName: "network", label: "Connections" },
];

/** Views the user can hide from the bar. */
export const OPTIONAL_ITEMS: ActivityBarItemDef[] = [
  { view: "files", icon: FolderOpen, iconName: "folder-open", label: "File browser" },
  { view: "recent-sessions", icon: History, iconName: "history", label: "Recent sessions" },
  { view: "workspaces", icon: LayoutGrid, iconName: "layout-grid", label: "Workspaces" },
  // One entry for what were Macros and Workflows (#5818). A lightning bolt reads
  // as "quick action"; the clapperboard read as video (#5848).
  { view: "automations", icon: Zap, iconName: "zap", label: "Automations" },
  // SSH tunnels and file servers (#6028).
  { view: "services", icon: Server, iconName: "server", label: "Services" },
  { view: "network-tools", icon: Stethoscope, iconName: "stethoscope", label: "Network tools" },
  { view: "plugins", icon: Puzzle, iconName: "puzzle", label: "Plugins" },
];

/** Whether a setting turned `view` off (Recent sessions is opt-out). */
export function isViewOffBySetting(
  view: SidebarView,
  settings: { showRecentSessions?: boolean | null }
): boolean {
  return view === "recent-sessions" && settings.showRecentSessions === false;
}
