import { useRef } from "react";
import { ArrowDown, ArrowUp, Copy, Gauge, MoreHorizontal, ShieldAlert, Trash2 } from "lucide-react";
import {
  Button,
  DropdownMenuContent,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  MenuItem,
  MenuSeparator,
  useModalPortalContainer,
} from "@/components/ui";

/** Props of {@link StepRowMenu}. */
export interface StepRowMenuProps {
  /** Path of the step (`0`, `2-then-1`). */
  path: string;
  /** Position in its list, from 0. */
  index: number;
  total: number;
  /** Show the step's failure options. */
  onFailure: () => void;
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
          icon={<MoreHorizontal size={14} />}
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
            icon={<Gauge size={14} />}
            onSelect={later(onSpeed)}
            data-testid={`automation-editor-step-speed-menu-${path}`}
          >
            Typing speed…
          </MenuItem>
        )}
        <MenuItem
          icon={<ShieldAlert size={14} />}
          onSelect={later(onFailure)}
          data-testid={`automation-editor-step-failure-menu-${path}`}
        >
          If this step fails…
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          icon={<ArrowUp size={14} />}
          disabled={index === 0}
          onSelect={() => onMove(-1)}
          data-testid={`automation-editor-step-up-${path}`}
        >
          Move up
        </MenuItem>
        <MenuItem
          icon={<ArrowDown size={14} />}
          disabled={index === total - 1}
          onSelect={() => onMove(1)}
          data-testid={`automation-editor-step-down-${path}`}
        >
          Move down
        </MenuItem>
        <MenuItem
          icon={<Copy size={14} />}
          onSelect={later(onDuplicate)}
          data-testid={`automation-editor-step-duplicate-${path}`}
        >
          Duplicate
        </MenuItem>
        <MenuItem
          danger
          icon={<Trash2 size={14} />}
          onSelect={later(onDelete)}
          data-testid={`automation-editor-step-delete-${path}`}
        >
          Delete
        </MenuItem>
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}
