import type React from "react";
import { Play, Pencil, Copy, Download, Trash2 } from "lucide-react";
import { Button, Tooltip } from "@/components/ui";
import { SidebarListItem } from "@/components/SidebarListItem";
import type { Macro } from "@/types/macro";
import { summariseMacroSteps } from "./macroStepFormat";

interface MacroListItemProps {
  macro: Macro;
  onPlay: (macroId: string) => void;
  onEdit: (macroId: string) => void;
  onDuplicate: (macroId: string) => void;
  onExport: (macroId: string) => void;
  onDelete: (macroId: string) => void;
  /** Roving-tabindex ref wiring the row into the sidebar's keyboard navigation. */
  rowRef?: (el: HTMLDivElement | null) => void;
  /** Roving-tabindex row props (role, tabIndex, aria-level, onFocus) for keyboard nav. */
  rowProps?: React.HTMLAttributes<HTMLDivElement>;
}

/**
 * A single macro row in the manager sidebar: name, a step-count badge, a
 * one-line preview of the recorded input, and the Play / Edit / Duplicate /
 * Delete actions. Double-click plays the macro (matching the workspace row's
 * double-click-to-launch affordance). Composed from the shared list-item shell.
 */
export function MacroListItem({
  macro,
  onPlay,
  onEdit,
  onDuplicate,
  onExport,
  onDelete,
  rowRef,
  rowProps,
}: MacroListItemProps) {
  const stepCount = macro.steps.length;
  const preview = summariseMacroSteps(macro.steps);

  return (
    <SidebarListItem
      ref={rowRef}
      {...rowProps}
      testId={`macro-item-${macro.id}`}
      nameTestId={`macro-name-${macro.id}`}
      name={macro.name}
      badge={`${stepCount} step${stepCount === 1 ? "" : "s"}`}
      badgeTestId={`macro-steps-${macro.id}`}
      onDoubleClick={() => onPlay(macro.id)}
      actions={
        <>
          <Tooltip content="Play" side="top">
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
        </>
      }
      details={
        <>
          {macro.description ? (
            <span className="macro-item__description">{macro.description}</span>
          ) : null}
          {preview ? (
            <code className="macro-item__preview" data-testid={`macro-preview-${macro.id}`}>
              {preview}
            </code>
          ) : null}
          {macro.tags.length > 0 ? (
            <span className="macro-item__tags" data-testid={`macro-tags-${macro.id}`}>
              {macro.tags.map((tag) => (
                <span className="macro-item__tag" key={tag}>
                  {tag}
                </span>
              ))}
            </span>
          ) : null}
        </>
      }
    />
  );
}
