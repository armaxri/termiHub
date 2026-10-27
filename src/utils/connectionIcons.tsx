import {
  Terminal,
  Wifi,
  Cable,
  Globe,
  Server,
  Container,
  BicepsFlexed,
  GitBranch,
  Folder,
  Icon as LucideIconRenderer,
  icons as lucideIconMap,
} from "lucide-react";
import type { LucideIcon, IconNode } from "lucide-react";
import * as labIcons from "@lucide/lab";
import type { ConnectionConfig, ShellType } from "@/types/terminal";
import lucideTags from "@/data/lucide-tags.json";
import { compareNames } from "@/utils/locale";
import { readConfigString } from "@/utils/connectionConfigFields";
import { isLocalConnectionConfig } from "@/utils/typedConnectionConfig";
import { getBasename } from "@/utils/paths";
import { useIconSurfaces } from "@/hooks/useIconSurfaces";
import { isSingleEmoji, resolveIconColor } from "@/utils/connectionIconStyle";

/** Default icon by connection type (non-local or local without special shell) */
const TYPE_ICONS: Record<string, LucideIcon> = {
  local: Terminal,
  ssh: Wifi,
  serial: Cable,
  telnet: Globe,
  docker: Container,
  remote: Server,
  "remote-session": Server,
};

/** Shell-specific icon overrides for local and remote shell connections.
 *
 * Accepts both short names ("powershell") and full paths ("/usr/local/bin/pwsh")
 * so it works for both local connections and remote-agent connections where the
 * agent reports absolute shell paths. */
function getShellIconInfo(shellType: ShellType | string | undefined): {
  component?: LucideIcon;
  iconNode?: IconNode;
} {
  if (!shellType) return { component: Terminal };
  // WSL must be checked first because it uses the "wsl:" prefix, not a path.
  if (shellType.startsWith("wsl:")) return { iconNode: labIcons.penguin as IconNode };
  // For path-based values, compare against the basename.
  const base = getBasename(shellType).toLowerCase();
  if (base === "powershell" || base === "powershell.exe" || base === "pwsh" || base === "pwsh.exe")
    return { component: BicepsFlexed };
  if (shellType === "gitbash" || base.includes("gitbash")) return { component: GitBranch };
  return { component: Terminal };
}

/** Resolve default icon info for a connection config */
export function getDefaultIconInfo(config: ConnectionConfig): {
  component?: LucideIcon;
  iconNode?: IconNode;
} {
  if (isLocalConnectionConfig(config)) {
    const shellValue = config.config.shell ?? config.config.shellType;
    return getShellIconInfo(shellValue);
  }
  if (config.type === "wsl") {
    return { iconNode: labIcons.penguin as IconNode };
  }
  if (config.type === "remote-session" || config.type === "remote") {
    // Schema-driven agent session: read the untyped bag via runtime-checked accessors.
    const sessionType = readConfigString(config, "sessionType");
    if (sessionType === "shell" || sessionType === "local") {
      return getShellIconInfo(readConfigString(config, "shell"));
    }
  }
  return { component: TYPE_ICONS[config.type] };
}

/**
 * Resolve a stored icon name to render info.
 * Names are PascalCase lucide-react names (e.g. "Terminal") or
 * "lab:camelCase" for @lucide/lab icons (e.g. "lab:penguin").
 */
function resolveIconByName(name: string): {
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

/** A single emoji drawn in an icon-sized box, in place of a lucide glyph. */
function EmojiGlyph({
  emoji,
  size,
  className,
  testId,
}: {
  emoji: string;
  size: number;
  className?: string;
  testId: string;
}) {
  return (
    <span
      className={["connection-icon__emoji", className].filter(Boolean).join(" ")}
      aria-hidden="true"
      data-testid={testId}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        width: size,
        height: size,
        fontSize: Math.round(size * 0.875),
        lineHeight: 1,
      }}
    >
      {emoji}
    </span>
  );
}

interface FolderIconProps {
  /** Optional folder icon colour: palette name or `#rrggbb` (#5020). */
  iconColor?: string | null;
  /** Optional single-emoji icon that replaces the folder glyph (#5020). */
  iconEmoji?: string | null;
  size?: number;
  className?: string;
}

/**
 * Renders a connection folder's icon: a valid `iconEmoji` wins, otherwise the
 * folder glyph tinted with `iconColor`, resolved against the active theme's
 * surfaces exactly like {@link ConnectionIcon} (#5020).
 */
export function FolderIcon({ iconColor, iconEmoji, size = 16, className }: FolderIconProps) {
  const surfaces = useIconSurfaces();
  if (iconEmoji && isSingleEmoji(iconEmoji)) {
    return (
      <EmojiGlyph emoji={iconEmoji} size={size} className={className} testId="folder-icon-emoji" />
    );
  }
  const color = resolveIconColor(iconColor, surfaces);
  const colorProps = color ? { color, "data-icon-color": iconColor ?? undefined } : {};
  return <Folder size={size} className={className} data-testid="folder-icon" {...colorProps} />;
}

interface ConnectionIconProps {
  config: ConnectionConfig;
  customIcon?: string;
  /** Optional per-connection icon colour: palette name or `#rrggbb` (#5008). */
  iconColor?: string | null;
  /** Optional single-emoji icon that replaces the glyph (#5008). */
  iconEmoji?: string | null;
  size?: number;
  className?: string;
}

/**
 * Renders the appropriate icon for a connection.
 *
 * A valid `iconEmoji` wins; otherwise `customIcon` (a lucide name) or the
 * shell-aware type default is drawn, tinted with `iconColor` resolved against
 * the active theme's sidebar/tab surfaces so it stays legible (#5008).
 */
export function ConnectionIcon({
  config,
  customIcon,
  iconColor,
  iconEmoji,
  size = 16,
  className,
}: ConnectionIconProps) {
  // Re-renders on theme switches so a palette colour picks the right shade.
  const surfaces = useIconSurfaces();

  if (iconEmoji && isSingleEmoji(iconEmoji)) {
    return (
      <EmojiGlyph
        emoji={iconEmoji}
        size={size}
        className={className}
        testId="connection-icon-emoji"
      />
    );
  }

  const color = resolveIconColor(iconColor, surfaces);
  const colorProps = color ? { color, "data-icon-color": iconColor ?? undefined } : {};
  const custom = customIcon ? resolveIconByName(customIcon) : null;
  const { component: Comp, iconNode } = custom ?? getDefaultIconInfo(config);

  if (iconNode) {
    return (
      <LucideIconRenderer iconNode={iconNode} size={size} className={className} {...colorProps} />
    );
  }
  if (Comp) {
    return <Comp size={size} className={className} {...colorProps} />;
  }
  return <Terminal size={size} className={className} {...colorProps} />;
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
  /** Searchable tags (e.g. "arm", "muscle" for BicepsFlexed) */
  tags: string[];
}

/** Convert PascalCase or camelCase to space-separated words */
function toDisplayName(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}

/** Convert PascalCase to kebab-case for tag lookup */
function toKebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

const tagMap = lucideTags as Record<string, string[]>;

let _catalog: IconCatalogEntry[] | null = null;

/** Get the full icon catalog (lazily built, cached). */
export function getIconCatalog(): IconCatalogEntry[] {
  if (_catalog) return _catalog;

  const entries: IconCatalogEntry[] = [];

  for (const name of Object.keys(lucideIconMap)) {
    const kebab = toKebabCase(name);
    const tags = tagMap[kebab] ?? [];
    entries.push({ name, displayName: toDisplayName(name), tags });
  }

  for (const name of Object.keys(labIcons)) {
    if (name === "__esModule" || name === "default") continue;
    const kebab = toKebabCase(name);
    const tags = tagMap[kebab] ?? [];
    entries.push({ name: `lab:${name}`, displayName: toDisplayName(name), tags });
  }

  entries.sort((a, b) => compareNames(a.displayName, b.displayName));
  _catalog = entries;
  return entries;
}
