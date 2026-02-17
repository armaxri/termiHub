import {
  Terminal,
  Wifi,
  Cable,
  Globe,
  Server,
  BicepsFlexed,
  GitBranch,
  Icon as LucideIconRenderer,
  icons as lucideIconMap,
} from "lucide-react";
import type { LucideIcon, IconNode } from "lucide-react";
import * as labIcons from "@lucide/lab";
import type { ConnectionConfig, ShellType } from "@/types/terminal";

/** Default icon by connection type (non-local or local without special shell) */
const TYPE_ICONS: Record<string, LucideIcon> = {
  local: Terminal,
  ssh: Wifi,
  serial: Cable,
  telnet: Globe,
  remote: Server,
};

/** Shell-specific icon overrides for local connections */
function getShellIconInfo(shellType: ShellType): { component?: LucideIcon; iconNode?: IconNode } {
  if (shellType === "powershell") return { component: BicepsFlexed };
  if (shellType === "gitbash") return { component: GitBranch };
  if (shellType.startsWith("wsl:")) return { iconNode: labIcons.penguin as IconNode };
  return { component: Terminal };
}

/** Resolve default icon info for a connection config */
export function getDefaultIconInfo(config: ConnectionConfig): {
  component?: LucideIcon;
  iconNode?: IconNode;
} {
  if (config.type === "local") {
    return getShellIconInfo(config.config.shellType);
  }
  return { component: TYPE_ICONS[config.type] };
}

/**
 * Resolve a stored icon name to render info.
 * Names are PascalCase lucide-react names (e.g. "Terminal") or
 * "lab:camelCase" for @lucide/lab icons (e.g. "lab:penguin").
 */
export function resolveIconByName(name: string): {
  component?: LucideIcon;
  iconNode?: IconNode;
} | null {
  if (name.startsWith("lab:")) {
    const labName = name.slice(4);
    const iconNode = (labIcons as Record<string, IconNode>)[labName];
    if (iconNode) return { iconNode };
    return null;
  }
  const comp = lucideIconMap[name as keyof typeof lucideIconMap];
  if (comp) return { component: comp };
  return null;
}

interface ConnectionIconProps {
  config: ConnectionConfig;
  customIcon?: string;
  size?: number;
  className?: string;
}

/**
 * Renders the appropriate icon for a connection.
 * Uses customIcon if provided, otherwise falls back to shell-aware defaults.
 */
export function ConnectionIcon({ config, customIcon, size = 16, className }: ConnectionIconProps) {
  const custom = customIcon ? resolveIconByName(customIcon) : null;
  const { component: Comp, iconNode } = custom ?? getDefaultIconInfo(config);

  if (iconNode) {
    return <LucideIconRenderer iconNode={iconNode} size={size} className={className} />;
  }
  if (Comp) {
    return <Comp size={size} className={className} />;
  }
  return <Terminal size={size} className={className} />;
}

/** Render an icon by its stored name string */
export function IconByName({
  name,
  size = 16,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const info = resolveIconByName(name);
  if (info?.iconNode) {
    return <LucideIconRenderer iconNode={info.iconNode} size={size} className={className} />;
  }
  if (info?.component) {
    const Comp = info.component;
    return <Comp size={size} className={className} />;
  }
  return <Terminal size={size} className={className} />;
}

// --- Icon catalog for the picker ---

export interface IconCatalogEntry {
  /** Stored value: PascalCase for lucide-react, "lab:camelCase" for lab */
  name: string;
  /** Human-readable name for display and search */
  displayName: string;
}

/** Convert PascalCase or camelCase to space-separated words */
function toDisplayName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

let _catalog: IconCatalogEntry[] | null = null;

/** Get the full icon catalog (lazily built, cached). */
export function getIconCatalog(): IconCatalogEntry[] {
  if (_catalog) return _catalog;

  const entries: IconCatalogEntry[] = [];

  for (const name of Object.keys(lucideIconMap)) {
    entries.push({ name, displayName: toDisplayName(name) });
  }

  for (const name of Object.keys(labIcons)) {
    if (name === "__esModule" || name === "default") continue;
    entries.push({ name: `lab:${name}`, displayName: toDisplayName(name) });
  }

  entries.sort((a, b) => a.displayName.localeCompare(b.displayName));
  _catalog = entries;
  return entries;
}
