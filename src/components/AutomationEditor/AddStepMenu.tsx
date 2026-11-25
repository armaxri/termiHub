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
import {
  offeredStepKinds,
  stepKindDescription,
  stepKindIcon,
  stepKindLabel,
  type AutomationStepKind,
} from "./stepMeta";

/** Props of {@link AddStepItems}. */
interface AddStepItemsProps {
  /** A step of the chosen kind was asked for. */
  onAdd: (kind: AutomationStepKind) => void;
  /** It adds to a nested list, which holds no nested lists of its own. */
  nested: boolean;
  testId: (kind: AutomationStepKind) => string;
}

/** The kinds a step can be, each with what it does: the everyday ones first. */
export function AddStepItems({ onAdd, nested, testId }: AddStepItemsProps) {
  const experimental = useExperimentalFeatures();
  const offered = offeredStepKinds(experimental, nested);
  const item = (kind: AutomationStepKind) => {
    const Icon = stepKindIcon(kind);
    return (
      <MenuItem
        key={kind}
        icon={<Icon size={14} />}
        description={stepKindDescription(kind)}
        onSelect={() => onAdd(kind)}
        data-testid={testId(kind)}
      >
        {stepKindLabel(kind)}
      </MenuItem>
    );
  };
  return (
    <>
      <MenuGroup>{offered.basic.map(item)}</MenuGroup>
      <MenuSeparator />
      <MenuGroup>
        <MenuLabel>More</MenuLabel>
        {offered.more.map(item)}
      </MenuGroup>
    </>
  );
}

/** Props of {@link AddStepMenu}. */
export interface AddStepMenuProps {
  /** Path of the nested list it adds to; absent for the automation's own steps. */
  nestedIn?: string;
  /**
   * Add before the step at this index (a "+" between two rows, A-029) instead of
   * at the end. The keyboard has "Add step below" in the row's menu.
   */
  before?: number;
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
export function AddStepMenu({ nestedIn, before, onAdd, onAdded }: AddStepMenuProps) {
  const portalContainer = useModalPortalContainer();
  const addedRef = useRef(false);
  const place = nestedIn === undefined ? "" : `-${nestedIn}`;
  const testIdBase =
    nestedIn === undefined
      ? "automation-editor-add-step"
      : `automation-editor-add-substep-${nestedIn}`;

  return (
    <DropdownMenuRoot>
      <DropdownMenuTrigger asChild>
        {before === undefined ? (
          <Button variant="secondary" size="sm" icon={<Plus size={14} />} data-testid={testIdBase}>
            Add step
          </Button>
        ) : (
          <button
            type="button"
            className="automation-steps__insert-button"
            tabIndex={-1}
            aria-label={`Add a step before step ${before + 1}`}
            data-testid={`automation-editor-insert-step${place}-${before}`}
          >
            <Plus size={12} aria-hidden="true" />
          </button>
        )}
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
        <AddStepItems
          nested={nestedIn !== undefined}
          onAdd={(kind) => {
            addedRef.current = true;
            onAdd(kind);
          }}
          testId={(kind) => `${testIdBase}-${kind}`}
        />
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}
