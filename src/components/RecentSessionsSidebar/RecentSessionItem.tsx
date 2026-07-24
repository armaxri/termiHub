import type React from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { Pin, PinOff, Plug, Save, Copy, Trash2, Star } from "lucide-react";
import { Button, Tooltip } from "@/components/ui";
import { SidebarListItem } from "@/components/SidebarListItem";
import { ConnectionIcon } from "@/utils/connectionIcons";
import { formatRelativeTime } from "@/utils/formatters";
import { sessionTypeBadge } from "@/utils/sessionHistoryTitle";
import type { SessionHistoryEntry } from "@/types/sessionHistory";

interface RecentSessionItemProps {
  entry: SessionHistoryEntry;
  onConnect: (entry: SessionHistoryEntry) => void;
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
 * A single recorded-session row: connection-type icon, `user@host` title, a
 * type badge, and relative last-used time. Single/double click reconnects; a
 * right-click context menu offers pin, save-as-connection, copy, and remove.
 */
export function RecentSessionItem({
  entry,
  onConnect,
  onTogglePin,
  onSaveAsConnection,
  onCopyString,
  onRemove,
  rowRef,
  rowProps,
}: RecentSessionItemProps) {
  const key = entry.dedupKey;

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <SidebarListItem
          ref={rowRef}
          {...rowProps}
          testId={`recent-session-${key}`}
          nameTestId={`recent-session-name-${key}`}
          name={entry.title}
          badge={sessionTypeBadge(entry.connectionType)}
          badgeTestId={`recent-session-type-${key}`}
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
            <span className="recent-sessions__item-meta" data-testid={`recent-session-meta-${key}`}>
              {entry.pinned && (
                <Pin size={10} className="recent-sessions__item-pin" aria-label="Pinned" />
              )}
              <span>{formatRelativeTime(new Date(entry.lastUsed).toISOString())}</span>
              {entry.useCount > 1 && <span>· {entry.useCount}×</span>}
              {entry.promoted && (
                <span className="recent-sessions__item-saved">
                  <Star size={10} /> Saved
                </span>
              )}
            </span>
          }
        />
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="context-menu__content">
          <ContextMenu.Item
            className="context-menu__item"
            onSelect={() => onConnect(entry)}
            data-testid={`recent-session-menu-connect-${key}`}
          >
            <Plug size={14} /> Connect
          </ContextMenu.Item>
          <ContextMenu.Separator className="context-menu__separator" />
          <ContextMenu.Item
            className="context-menu__item"
            onSelect={() => onTogglePin(entry)}
            data-testid={`recent-session-menu-pin-${key}`}
          >
            {entry.pinned ? <PinOff size={14} /> : <Pin size={14} />}{" "}
            {entry.pinned ? "Unpin" : "Pin to Top"}
          </ContextMenu.Item>
          <ContextMenu.Item
            className="context-menu__item"
            onSelect={() => onSaveAsConnection(entry)}
            data-testid={`recent-session-menu-save-${key}`}
          >
            <Save size={14} /> Save as Connection…
          </ContextMenu.Item>
          <ContextMenu.Separator className="context-menu__separator" />
          <ContextMenu.Item
            className="context-menu__item"
            onSelect={() => onCopyString(entry)}
            data-testid={`recent-session-menu-copy-${key}`}
          >
            <Copy size={14} /> Copy Connection String
          </ContextMenu.Item>
          <ContextMenu.Item
            className="context-menu__item"
            onSelect={() => onRemove(entry)}
            data-testid={`recent-session-menu-remove-${key}`}
          >
            <Trash2 size={14} /> Remove from History
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
