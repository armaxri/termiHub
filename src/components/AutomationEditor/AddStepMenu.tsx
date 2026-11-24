import { useRef } from "react";
import { Plus } from "lucide-react";
import {
  Button,
  DropdownMenuContent,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  useModalPortalContainer,
} from "@/components/ui";
import { useExperimentalFeatures } from "@/hooks/useExperimentalFeatures";
import { offeredStepKinds, stepKindIcon, stepKindLabel, type AutomationStepKind } from "./stepMeta";

/** Props of {@link AddStepMenu}. */
export interface AddStepMenuProps {
  /** Path of the nested list it adds to; absent for the automation's own steps. */
  nestedIn?: string;
  /** Add a step of the chosen kind. */
  onAdd: (kind: AutomationStepKind) => void;
  /** The menu closed after adding: focus the new step instead of the button. */
  onAdded: () => void;
}

/**
 * The "Add step" menu: the everyday kinds first, the rest under "More" (#5818).
 * It portals into the dialog's content node: a modal dialog sets
 * `pointer-events: none` on the body, which leaves a menu there dead (#1868).
 */
export function AddStepMenu({ nestedIn, onAdd, onAdded }: AddStepMenuProps) {
  const portalContainer = useModalPortalContainer();
  const experimental = useExperimentalFeatures();
  const offered = offeredStepKinds(experimental, nestedIn !== undefined);
  const addedRef = useRef(false);

  const item = (kind: AutomationStepKind) => {
    const Icon = stepKindIcon(kind);
    return (
      <MenuItem
        key={kind}
        icon={<Icon size={14} />}
        onSelect={() => {
          addedRef.current = true;
          onAdd(kind);
        }}
        data-testid={
          nestedIn === undefined
            ? `automation-editor-add-step-${kind}`
            : `automation-editor-add-substep-${nestedIn}-${kind}`
        }
      >
        {stepKindLabel(kind)}
      </MenuItem>
    );
  };

  return (
    <DropdownMenuRoot>
      <DropdownMenuTrigger asChild>
        <Button
          variant="secondary"
          size="sm"
          icon={<Plus size={14} />}
          data-testid={
            nestedIn === undefined
              ? "automation-editor-add-step"
              : `automation-editor-add-substep-${nestedIn}`
          }
        >
          Add step
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        container={portalContainer}
        align="start"
        sideOffset={4}
        onCloseAutoFocus={(e) => {
          if (!addedRef.current) return;
          addedRef.current = false;
          e.preventDefault();
          onAdded();
        }}
      >
        <MenuGroup>{offered.basic.map(item)}</MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuLabel>More</MenuLabel>
          {offered.more.map(item)}
        </MenuGroup>
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}
