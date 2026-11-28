import type React from "react";
import { Pin, PinOff, Plug, Save, Copy, Trash2, SplitSquareHorizontal } from "lucide-react";
import {
  Button,
  Tooltip,
  ContextMenuContent,
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuItem,
  MenuSeparator,
} from "@/components/ui";
import { SidebarListItem } from "@/components/SidebarListItem";
import { ConnectionIcon } from "@/utils/connectionIcons";
import { formatRelativeTime } from "@/utils/formatters";
import { sessionTypeBadge } from "@/utils/sessionHistoryTitle";
import type { SessionHistoryEntry } from "@/types/sessionHistory";
import { t, tf } from "@/i18n/catalog";

import { ICON_SIZE } from "@/components/ui/iconSize";
/**
 * The recent-session row's tooltip lines (#5770): the connection type, when
 * it was last used, how often, and whether it is saved as a connection. The
 * row shows only the session's title and a pin marker.
 */
export function recentSessionRowTooltip(entry: SessionHistoryEntry): string[] {
  const out = [
    sessionTypeBadge(entry.connectionType),
    tf("recent.tooltip.lastUsed", {
      when: formatRelativeTime(new Date(entry.lastUsed).toISOString()),
    }),
  ];
  if (entry.useCount > 1) out.push(tf("recent.tooltip.uses", { count: entry.useCount }));
  if (entry.promoted) out.push(t("recent.tooltip.saved"));
  return out;
}

interface RecentSessionItemProps {
  entry: SessionHistoryEntry;
  onConnect: (entry: SessionHistoryEntry) => void;
  onConnectInNewPanel: (entry: SessionHistoryEntry) => void;
  onTogglePin: (entry: SessionHistoryEntry) => void;
  onSaveAsConnection: (entry: SessionHistoryEntry) => void;
  onCopyString: (entry: SessionHistoryEntry) => void;
  onRemove: (entry: SessionHistoryEntry) => void;
  /** Roving-tabindex ref wiring the row into the sidebar's keyboard navigation. */
  rowRef?: (el: HTMLDivElement | null) => void;
  /** Roving-tabindex row props (role, tabIndex, aria-level, onFocus). */
  rowProps?: React.HTMLAttributes<HTMLDivElement>;
}

/**
 * A single recorded-session row: connection-type icon, `user@host` title and
 * a pin marker; the type, last use and use count are in its tooltip (#5770).
 * Single/double click reconnects; a
 * right-click context menu offers connect-in-new-panel, pin,
 * save-as-connection, copy, and remove.
 */
export function RecentSessionItem({
  entry,
  onConnect,
  onConnectInNewPanel,
  onTogglePin,
  onSaveAsConnection,
  onCopyString,
  onRemove,
  rowRef,
  rowProps,
}: RecentSessionItemProps) {
  const key = entry.dedupKey;

  return (
    <ContextMenuRoot>
      <ContextMenuTrigger asChild>
        <SidebarListItem
          ref={rowRef}
          {...rowProps}
          testId={`recent-session-${key}`}
          nameTestId={`recent-session-name-${key}`}
          name={entry.title}
          tooltip={recentSessionRowTooltip(entry)}
          tooltipTestId={`recent-session-tooltip-${key}`}
          onDoubleClick={() => onConnect(entry)}
          status={
            <span className="recent-sessions__item-icon" aria-hidden="true">
              <ConnectionIcon config={entry.config} size={ICON_SIZE.sm} />
            </span>
          }
          actions={
            <>
              <Tooltip content="Connect" side="top">
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label="Connect"
                  data-testid={`recent-session-connect-${key}`}
                  icon={<Plug size={ICON_SIZE.xs} />}
                  onClick={(e) => {
                    e.stopPropagation();
                    onConnect(entry);
                  }}
                />
              </Tooltip>
              <Tooltip content={entry.pinned ? "Unpin" : "Pin to top"} side="top">
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label={entry.pinned ? "Unpin" : "Pin to top"}
                  data-testid={`recent-session-pin-${key}`}
                  icon={entry.pinned ? <PinOff size={ICON_SIZE.xs} /> : <Pin size={ICON_SIZE.xs} />}
                  onClick={(e) => {
                    e.stopPropagation();
                    onTogglePin(entry);
                  }}
                />
              </Tooltip>
              <Tooltip content="Remove from history" side="top">
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label="Remove from history"
                  data-testid={`recent-session-remove-${key}`}
                  icon={<Trash2 size={ICON_SIZE.xs} />}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(entry);
                  }}
                />
              </Tooltip>
            </>
          }
          details={
            entry.pinned ? (
              <span
                className="recent-sessions__item-meta"
                data-testid={`recent-session-meta-${key}`}
              >
                <Pin size={ICON_SIZE.xs} className="recent-sessions__item-pin" aria-hidden="true" />
                <span>{t("recent.marker.pinned")}</span>
              </span>
            ) : undefined
          }
        />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <MenuItem
          onSelect={() => onConnect(entry)}
          data-testid={`recent-session-menu-connect-${key}`}
        >
          <Plug size={ICON_SIZE.sm} /> Connect
        </MenuItem>
        <MenuItem
          onSelect={() => onConnectInNewPanel(entry)}
          data-testid={`recent-session-menu-connect-new-panel-${key}`}
        >
          <SplitSquareHorizontal size={ICON_SIZE.sm} /> Connect in new panel
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          onSelect={() => onTogglePin(entry)}
          data-testid={`recent-session-menu-pin-${key}`}
        >
          {entry.pinned ? <PinOff size={ICON_SIZE.sm} /> : <Pin size={ICON_SIZE.sm} />}{" "}
          {entry.pinned ? "Unpin" : "Pin to top"}
        </MenuItem>
        <MenuItem
          onSelect={() => onSaveAsConnection(entry)}
          data-testid={`recent-session-menu-save-${key}`}
        >
          <Save size={ICON_SIZE.sm} /> Save as connection…
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          onSelect={() => onCopyString(entry)}
          data-testid={`recent-session-menu-copy-${key}`}
        >
          <Copy size={ICON_SIZE.sm} /> Copy connection string
        </MenuItem>
        <MenuItem
          onSelect={() => onRemove(entry)}
          data-testid={`recent-session-menu-remove-${key}`}
        >
          <Trash2 size={ICON_SIZE.sm} /> Remove from history
        </MenuItem>
      </ContextMenuContent>
    </ContextMenuRoot>
  );
}
