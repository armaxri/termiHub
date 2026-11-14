import type React from "react";
import { Play, Pencil, Copy, Download, Trash2, CalendarClock, History } from "lucide-react";
import { Button, Tooltip } from "@/components/ui";
import { SidebarListItem } from "@/components/SidebarListItem";
import type { Macro, MacroRun } from "@/types/macro";
import { t, tf } from "@/i18n/catalog";
import { macroRowTooltip } from "./macroRowTooltip";

interface MacroListItemProps {
  macro: Macro;
  onPlay: (macroId: string) => void;
  onEdit: (macroId: string) => void;
  /** Open the schedule editor for this macro (PROD-043). */
  onSchedule?: (macroId: string) => void;
  /** Narrow the run-history panel to this macro's playbacks (#3543). */
  onShowHistory?: (macroId: string) => void;
  onDuplicate: (macroId: string) => void;
  onExport: (macroId: string) => void;
  onDelete: (macroId: string) => void;
  /**
   * Label of the terminal Play types into (the active terminal tab), shown in
   * Play's tooltip as "Play in: <terminal>" (R-113, #5680); `null` when no
   * terminal is active.
   */
  playTarget?: string | null;
  /** This macro's most recent playback, for the tooltip's "Last run" line (#5680). */
  lastRun?: MacroRun;
  /** Roving-tabindex ref wiring the row into the sidebar's keyboard navigation. */
  rowRef?: (el: HTMLDivElement | null) => void;
  /** Roving-tabindex row props (role, tabIndex, aria-level, onFocus) for keyboard nav. */
  rowProps?: React.HTMLAttributes<HTMLDivElement>;
}

/**
 * A single macro row in the manager sidebar: the name first (it is what users
 * scan and search for, #5519; no leading step-count badge), the user's
 * description when there is one, and the Play / Edit / Duplicate / Delete
 * actions. What it types, its last run and its tags are in the name's tooltip
 * ({@link macroRowTooltip}, #5757). Play is always visible after the name (#5636: playing is the
 * panel's main purpose, so it must not depend on hover discovery); the other
 * actions form a group revealed on hover/focus that overlays the name's tail.
 * Double-click plays the macro (matching the workspace row's
 * double-click-to-launch affordance). Composed from the shared list-item shell.
 */
export function MacroListItem({
  macro,
  onPlay,
  onEdit,
  onSchedule,
  onShowHistory,
  onDuplicate,
  onExport,
  onDelete,
  playTarget = null,
  lastRun,
  rowRef,
  rowProps,
}: MacroListItemProps) {
  const playTooltip = playTarget
    ? tf("macro.play.target", { target: playTarget })
    : t("macro.play.noTarget");

  return (
    <SidebarListItem
      ref={rowRef}
      {...rowProps}
      testId={`macro-item-${macro.id}`}
      nameTestId={`macro-name-${macro.id}`}
      name={macro.name}
      description={macro.description}
      descriptionTestId={`macro-description-${macro.id}`}
      tooltip={macroRowTooltip(macro, lastRun)}
      tooltipTestId={`macro-tooltip-${macro.id}`}
      className="macro-item"
      onDoubleClick={() => onPlay(macro.id)}
      actionsVisible
      actions={
        <>
          <Tooltip content={playTooltip} side="top">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Play"
              data-testid={`macro-play-${macro.id}`}
              icon={<Play size={12} />}
              onClick={(e) => {
                e.stopPropagation();
                onPlay(macro.id);
              }}
            />
          </Tooltip>
          <span
            className="macro-item__more"
            role="group"
            aria-label={`More actions for ${macro.name}`}
            data-testid={`macro-more-${macro.id}`}
          >
            <Tooltip content="Edit" side="top">
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label="Edit"
                data-testid={`macro-edit-${macro.id}`}
                icon={<Pencil size={12} />}
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit(macro.id);
                }}
              />
            </Tooltip>
            {onSchedule ? (
              <Tooltip content="Schedule…" side="top">
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label="Schedule"
                  data-testid={`macro-schedule-${macro.id}`}
                  icon={<CalendarClock size={12} />}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSchedule(macro.id);
                  }}
                />
              </Tooltip>
            ) : null}
            {onShowHistory ? (
              <Tooltip content="Recent runs" side="top">
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label="Recent runs"
                  data-testid={`macro-history-${macro.id}`}
                  icon={<History size={12} />}
                  onClick={(e) => {
                    e.stopPropagation();
                    onShowHistory(macro.id);
                  }}
                />
              </Tooltip>
            ) : null}
            <Tooltip content="Duplicate" side="top">
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label="Duplicate"
                data-testid={`macro-duplicate-${macro.id}`}
                icon={<Copy size={12} />}
                onClick={(e) => {
                  e.stopPropagation();
                  onDuplicate(macro.id);
                }}
              />
            </Tooltip>
            <Tooltip content="Export" side="top">
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label="Export"
                data-testid={`macro-export-${macro.id}`}
                icon={<Download size={12} />}
                onClick={(e) => {
                  e.stopPropagation();
                  onExport(macro.id);
                }}
              />
            </Tooltip>
            <Tooltip content="Delete" side="top">
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label="Delete"
                data-testid={`macro-delete-${macro.id}`}
                icon={<Trash2 size={12} />}
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(macro.id);
                }}
              />
            </Tooltip>
          </span>
        </>
      }
    />
  );
}
