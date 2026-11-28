import type React from "react";
import { Check, ChevronDown } from "lucide-react";
import {
  Button,
  DropdownMenuContent,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  MenuCheckboxItem,
  MenuItem,
  MenuItemIndicator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  Tooltip,
} from "@/components/ui";
import type { FileBrowserAction } from "./FileBrowserActions";

import { ICON_SIZE } from "@/components/ui/iconSize";
/** Whether the entry just chosen opens a field that must keep the focus. */
let fieldOpening = false;

/**
 * The `onSelect` of a menu entry. A closing menu hands focus back to its
 * trigger, which would take it from the inline name field "New ▸ File" opens
 * (`autoFocus`); an entry that `opensField` therefore runs once the menu has
 * closed (so the field mounts after the menu's focus trap is gone) and the
 * menu skips that focus return ({@link keepFieldFocus}, #5832).
 */
function entrySelect(action: FileBrowserAction): (() => void) | undefined {
  const run = action.onClick;
  if (!run || !action.opensField) return run;
  return () => {
    fieldOpening = true;
    window.setTimeout(run, 0);
  };
}

/** `onCloseAutoFocus` of a file-browser menu: see {@link entrySelect}. */
export function keepFieldFocus(event: Event): void {
  if (!fieldOpening) return;
  fieldOpening = false;
  event.preventDefault();
}

/** A tick column for a toggle or radio entry; it keeps its room when unchecked. */
export function MenuTick(): React.ReactElement {
  return (
    <span className="file-browser__menu-tick">
      <MenuItemIndicator>
        <Check size={ICON_SIZE.sm} />
      </MenuItemIndicator>
    </span>
  );
}

/**
 * One action as an overflow-menu entry: a plain command, a toggle (a checkbox
 * entry whose tick sits in the icon column, #5832), a sub-menu of its
 * `children` ("New ▸ File / Folder"), or the action's own `menuNode`.
 */
export function ActionMenuEntry({ action }: { action: FileBrowserAction }): React.ReactElement {
  if (action.menuNode !== undefined) return <>{action.menuNode}</>;
  if (action.children !== undefined) {
    return (
      <MenuSub>
        <MenuSubTrigger icon={action.icon} disabled={action.disabled} data-testid={action.testId}>
          {action.label}
        </MenuSubTrigger>
        <MenuSubContent sideOffset={4} data-testid={`${action.testId}-menu`}>
          {action.children.map((child) => (
            <ActionMenuEntry key={child.id} action={child} />
          ))}
        </MenuSubContent>
      </MenuSub>
    );
  }
  if (action.checked !== undefined) {
    return (
      <MenuCheckboxItem
        checked={action.checked}
        disabled={action.disabled}
        onSelect={entrySelect(action)}
        data-testid={action.testId}
      >
        <MenuTick />
        {action.label}
      </MenuCheckboxItem>
    );
  }
  return (
    <MenuItem
      icon={action.icon}
      disabled={action.disabled}
      onSelect={entrySelect(action)}
      data-testid={action.testId}
    >
      {action.label}
    </MenuItem>
  );
}

/**
 * An inline action with `children`, as a small menu button ("+ ▾"): one
 * toolbar slot for several related commands (#5832: New ▸ File / Folder).
 */
export function InlineMenuButton({ action }: { action: FileBrowserAction }): React.ReactElement {
  return (
    <DropdownMenuRoot>
      <Tooltip content={action.tooltip ?? action.label} side="top">
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            icon={action.icon}
            disabled={action.disabled}
            aria-label={action.label}
            className="file-browser__actions-menu-button"
            data-testid={action.testId}
            data-icon={action.iconName}
          >
            <ChevronDown
              size={ICON_SIZE.xs}
              aria-hidden="true"
              className="file-browser__actions-caret"
            />
          </Button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent
        align="start"
        sideOffset={4}
        onCloseAutoFocus={keepFieldFocus}
        data-testid={`${action.testId}-menu`}
      >
        {action.children?.map((child) => (
          <ActionMenuEntry key={child.id} action={child} />
        ))}
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}
