import {
  CalendarClock,
  Copy,
  Download,
  History,
  ListChecks,
  Pencil,
  Play,
  Plus,
  Square,
  Trash2,
} from "lucide-react";
import { MenuItem, MenuSeparator } from "@/components/ui";

/** Everything a row's menus can do with one automation. */
export interface AutomationRowActions {
  /** Run on the active terminal (or ask where, without one). */
  onRun: (automationId: string) => void;
  /** Stop every run of the automation. */
  onStop: (automationId: string) => void;
  /** Open the run picker. */
  onRunOn: (automationId: string) => void;
  /** Open its editor. */
  onEdit: (automationId: string) => void;
  /** Open the schedule editor with it picked. */
  onSchedule: (automationId: string) => void;
  /** Show its runs in the History section. */
  onShowHistory: (automationId: string) => void;
  /** Save a copy. */
  onDuplicate: (automationId: string) => void;
  /** Start a new step-by-step automation that runs this one. */
  onUseInNew: (automationId: string) => void;
  /** Export it to a file. */
  onExport: (automationId: string) => void;
  /** Ask, then delete it. */
  onDelete: (automationId: string) => void;
}

interface AutomationRowMenuProps {
  automationId: string;
  running: boolean;
  /** Whether "New automation from this…" applies (typed keystrokes only). */
  canUseInNew: boolean;
  actions: AutomationRowActions;
}

/**
 * The entries of a row's "…" menu and of its right-click menu: every action as
 * text (R-037, R-049), so nothing depends on recognising an icon.
 */
export function AutomationRowMenu({
  automationId: id,
  running,
  canUseInNew,
  actions,
}: AutomationRowMenuProps) {
  return (
    <>
      {running ? (
        <MenuItem
          icon={<Square size={14} />}
          onSelect={() => actions.onStop(id)}
          data-testid={`automation-menu-stop-${id}`}
        >
          Stop
        </MenuItem>
      ) : (
        <MenuItem
          icon={<Play size={14} />}
          onSelect={() => actions.onRun(id)}
          data-testid={`automation-menu-run-${id}`}
        >
          Run
        </MenuItem>
      )}
      <MenuItem
        icon={<ListChecks size={14} />}
        disabled={running}
        onSelect={() => actions.onRunOn(id)}
        data-testid={`automation-menu-run-on-${id}`}
      >
        Run on…
      </MenuItem>
      <MenuItem
        icon={<CalendarClock size={14} />}
        onSelect={() => actions.onSchedule(id)}
        data-testid={`automation-menu-schedule-${id}`}
      >
        Schedule…
      </MenuItem>
      <MenuItem
        icon={<History size={14} />}
        onSelect={() => actions.onShowHistory(id)}
        data-testid={`automation-menu-history-${id}`}
      >
        Recent runs
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        icon={<Pencil size={14} />}
        onSelect={() => actions.onEdit(id)}
        data-testid={`automation-menu-edit-${id}`}
      >
        Edit…
      </MenuItem>
      <MenuItem
        icon={<Copy size={14} />}
        onSelect={() => actions.onDuplicate(id)}
        data-testid={`automation-menu-duplicate-${id}`}
      >
        Duplicate
      </MenuItem>
      {canUseInNew ? (
        <MenuItem
          icon={<Plus size={14} />}
          onSelect={() => actions.onUseInNew(id)}
          data-testid={`automation-menu-use-in-new-${id}`}
        >
          New automation from this…
        </MenuItem>
      ) : null}
      <MenuItem
        icon={<Download size={14} />}
        onSelect={() => actions.onExport(id)}
        data-testid={`automation-menu-export-${id}`}
      >
        Export…
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        icon={<Trash2 size={14} />}
        danger
        onSelect={() => actions.onDelete(id)}
        data-testid={`automation-menu-delete-${id}`}
      >
        Delete…
      </MenuItem>
    </>
  );
}
