import { forwardRef } from "react";
import { CircleDot } from "lucide-react";
import {
  Button,
  DropdownMenuContent,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  MenuItem,
  MenuLabel,
  Tooltip,
  useModalPortalContainer,
} from "@/components/ui";
import { useRunTargets } from "@/components/Automations/useRunTargets";

/** Props of {@link RecordStepsButton}. */
export interface RecordStepsButtonProps {
  /** Record in this terminal. */
  onRecord: (tabId: string) => void;
}

/**
 * "Record steps" (#5818, slice 8): records into the open draft in a terminal the
 * user picks. With one connected terminal there is nothing to pick.
 */
export const RecordStepsButton = forwardRef<HTMLButtonElement, RecordStepsButtonProps>(
  function RecordStepsButton({ onRecord }, ref) {
    const portalContainer = useModalPortalContainer();
    const { terminals, active } = useRunTargets();
    const live = terminals.filter((t) => t.live);
    // The active terminal first: it is the one meant most often.
    const choices = [
      ...live.filter((t) => t.id === active?.id),
      ...live.filter((t) => t.id !== active?.id),
    ];

    if (choices.length <= 1) {
      const only = choices[0];
      return (
        <Tooltip
          content={
            only
              ? `Type in ${only.title}; what you type becomes a step`
              : "Open a terminal to record in"
          }
        >
          <Button
            ref={ref}
            variant="ghost"
            size="sm"
            icon={<CircleDot size={14} />}
            aria-disabled={!only}
            onClick={() => {
              if (only) onRecord(only.id);
            }}
            data-testid="automation-editor-record"
          >
            Record steps
          </Button>
        </Tooltip>
      );
    }
    return (
      <DropdownMenuRoot>
        <DropdownMenuTrigger asChild>
          <Button
            ref={ref}
            variant="ghost"
            size="sm"
            icon={<CircleDot size={14} />}
            data-testid="automation-editor-record"
          >
            Record steps…
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent container={portalContainer} align="end" sideOffset={4}>
          <MenuLabel>Record in</MenuLabel>
          {choices.map((terminal) => (
            <MenuItem
              key={terminal.id}
              onSelect={() => onRecord(terminal.id)}
              data-testid={`automation-editor-record-in-${terminal.id}`}
            >
              {terminal.title || "Terminal"}
            </MenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenuRoot>
    );
  }
);
