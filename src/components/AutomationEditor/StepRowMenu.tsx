import { useRef } from "react";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Gauge,
  MoreHorizontal,
  Plus,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import {
  Button,
  DropdownMenuContent,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  useModalPortalContainer,
} from "@/components/ui";

import { AddStepItems } from "./AddStepMenu";
import type { AutomationStepKind } from "./stepMeta";

import { ICON_SIZE } from "@/components/ui/iconSize";
/** Props of {@link StepRowMenu}. */
export interface StepRowMenuProps {
  /** Path of the step (`0`, `2-then-1`). */
  path: string;
  /** Position in its list, from 0. */
  index: number;
  total: number;
  /** Path of the nested list it sits in, if any. */
  nestedIn?: string;
  /** Add a step of `kind` right after this one; returns what to do once the menu closed. */
  onAddBelow: (kind: AutomationStepKind) => () => void;
  /** Show the step's failure options; absent for a step that has none. */
  onFailure?: () => void;
  /** Show the step's typing speed; absent for a step that does not type keys. */
  onSpeed?: () => void;
  onMove: (direction: -1 | 1) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

/** A step row's "…" menu: its options and what can be done with it (#5818). */
export function StepRowMenu({
  path,
  index,
  total,
  nestedIn,
  onAddBelow,
  onFailure,
  onSpeed,
  onMove,
  onDuplicate,
  onDelete,
}: StepRowMenuProps) {
  const portalContainer = useModalPortalContainer();
  // An entry that opens or moves focus elsewhere must not lose it to the button.
  const afterClose = useRef<(() => void) | null>(null);
  const later = (action: () => void) => () => {
    afterClose.current = action;
  };

  return (
    <DropdownMenuRoot>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon={<MoreHorizontal size={ICON_SIZE.sm} />}
          aria-label={`More options for step ${index + 1}`}
          data-testid={`automation-editor-step-more-${path}`}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        container={portalContainer}
        align="end"
        sideOffset={4}
        onCloseAutoFocus={(e) => {
          const action = afterClose.current;
          if (!action) return;
          afterClose.current = null;
          e.preventDefault();
          action();
        }}
      >
        {onSpeed && (
          <MenuItem
            icon={<Gauge size={ICON_SIZE.sm} />}
            onSelect={later(onSpeed)}
            data-testid={`automation-editor-step-speed-menu-${path}`}
          >
            Typing speed…
          </MenuItem>
        )}
        {onFailure && (
          <MenuItem
            icon={<ShieldAlert size={ICON_SIZE.sm} />}
            onSelect={later(onFailure)}
            data-testid={`automation-editor-step-failure-menu-${path}`}
          >
            If this step fails…
          </MenuItem>
        )}
        {(onSpeed || onFailure) && <MenuSeparator />}
        <MenuSub>
          <MenuSubTrigger
            icon={<Plus size={ICON_SIZE.sm} />}
            data-testid={`automation-editor-step-add-below-${path}`}
          >
            Add step below
          </MenuSubTrigger>
          <MenuSubContent container={portalContainer} collisionPadding={8}>
            <AddStepItems
              nestedIn={nestedIn}
              below={path}
              onAdd={(kind) => later(onAddBelow(kind))()}
            />
          </MenuSubContent>
        </MenuSub>
        <MenuItem
          icon={<ArrowUp size={ICON_SIZE.sm} />}
          disabled={index === 0}
          onSelect={() => onMove(-1)}
          data-testid={`automation-editor-step-up-${path}`}
        >
          Move up
        </MenuItem>
        <MenuItem
          icon={<ArrowDown size={ICON_SIZE.sm} />}
          disabled={index === total - 1}
          onSelect={() => onMove(1)}
          data-testid={`automation-editor-step-down-${path}`}
        >
          Move down
        </MenuItem>
        <MenuItem
          icon={<Copy size={ICON_SIZE.sm} />}
          onSelect={later(onDuplicate)}
          data-testid={`automation-editor-step-duplicate-${path}`}
        >
          Duplicate
        </MenuItem>
        <MenuItem
          danger
          icon={<Trash2 size={ICON_SIZE.sm} />}
          onSelect={later(onDelete)}
          data-testid={`automation-editor-step-delete-${path}`}
        >
          Delete
        </MenuItem>
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}
