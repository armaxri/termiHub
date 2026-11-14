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
              <ConnectionIcon config={entry.config} size={15} />
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
                  icon={<Plug size={12} />}
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
                  icon={entry.pinned ? <PinOff size={12} /> : <Pin size={12} />}
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
                  icon={<Trash2 size={12} />}
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
                <Pin size={10} className="recent-sessions__item-pin" aria-hidden="true" />
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
          <Plug size={14} /> Connect
        </MenuItem>
        <MenuItem
          onSelect={() => onConnectInNewPanel(entry)}
          data-testid={`recent-session-menu-connect-new-panel-${key}`}
        >
          <SplitSquareHorizontal size={14} /> Connect in new panel
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          onSelect={() => onTogglePin(entry)}
          data-testid={`recent-session-menu-pin-${key}`}
        >
          {entry.pinned ? <PinOff size={14} /> : <Pin size={14} />}{" "}
          {entry.pinned ? "Unpin" : "Pin to top"}
        </MenuItem>
        <MenuItem
          onSelect={() => onSaveAsConnection(entry)}
          data-testid={`recent-session-menu-save-${key}`}
        >
          <Save size={14} /> Save as connection…
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          onSelect={() => onCopyString(entry)}
          data-testid={`recent-session-menu-copy-${key}`}
        >
          <Copy size={14} /> Copy connection string
        </MenuItem>
        <MenuItem
          onSelect={() => onRemove(entry)}
          data-testid={`recent-session-menu-remove-${key}`}
        >
          <Trash2 size={14} /> Remove from history
        </MenuItem>
      </ContextMenuContent>
    </ContextMenuRoot>
  );
}
