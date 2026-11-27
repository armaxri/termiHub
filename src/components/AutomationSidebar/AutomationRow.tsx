import { AlertTriangle, Ban, Hand, MoreHorizontal, Pencil, Play, Square } from "lucide-react";
import { missingCalleeStep } from "@/utils/runBlocked";
import {
  Button,
  ContextMenuContent,
  ContextMenuRoot,
  ContextMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  Spinner,
  Tooltip,
} from "@/components/ui";
import { SidebarListItem } from "@/components/SidebarListItem";
import type { FlatRovingItemProps } from "@/hooks/useFlatRovingNav";
import { t, tf } from "@/i18n/catalog";
import { modKeyAccelerator } from "@/services/keybindings";
import { isMacroShaped } from "@/store/slices/automationViews";
import type { Automation } from "@/types/generated/Automation";
import {
  automationRowTooltip,
  triggerState,
  type AutomationRunSummary,
  type ConnectionName,
} from "./automationRowInfo";
import { keepOffRow, RowLines } from "./AutomationRowLines";
import { AutomationRowMenu, type AutomationRowActions } from "./AutomationRowMenu";

/**
 * How long a row stays marked after it is saved from an editor (#5687). The
 * `.automation-item--just-saved` fade in AutomationSidebar.css runs as long.
 */
export const AUTOMATION_JUST_SAVED_MS = 3000;

/** One terminal an automation is running on. */
export interface AutomationRunTarget {
  /** Stable key: the run id, or the tab id of a keystroke playback. */
  key: string;
  /** The terminal's name. */
  label: string;
  /** Where it runs and how far it is, e.g. "in bash, step 5 of 12". */
  progress: string;
  /** It waits for the user (#6025). */
  waiting: boolean;
  /** Bring the terminal to the front. */
  onShow: () => void;
  /** Stop the run on this terminal only. */
  onStop: () => void;
}

/** Props of {@link AutomationRow}. */
export interface AutomationRowProps {
  automation: Automation;
  /** The terminals it runs on right now; empty when it is not running. */
  targets: AutomationRunTarget[];
  /** What the run history says about it. */
  runs?: AutomationRunSummary;
  /** The active terminal's name, which Run types into; `null` without one. */
  runTarget: string | null;
  /** The sidebar is too narrow for marker words: markers show as icons. */
  compact?: boolean;
  /** Why it cannot run at all; `null` when it can (#6026). */
  blocked: string | null;
  /** When a schedule runs it next; `null` without one that is on. */
  nextRun: string | null;
  /** Resolves a saved connection id to its name, for triggers. */
  connectionName: ConnectionName;
  /** Finds an automation by id. */
  resolve: (id: string) => Automation | undefined;
  /** Turn its triggers, hotkeys included, on or off (#5674). */
  onSetTriggers: (automationId: string, on: boolean) => void;
  /** Every other action. */
  actions: AutomationRowActions;
  /** It was just saved: tint the row briefly (#5687). */
  justSaved?: boolean;
  /** Roving-tabindex props of the row (ref included). */
  rowProps: FlatRovingItemProps<HTMLDivElement>;
}

/**
 * One automation in the sidebar: the name (what users scan and search for,
 * #5519), the user's description when there is one, and Run, always visible,
 * which becomes Stop while it runs (#5636, R-075). Under them the row says, in
 * words, what no icon can (#6026): what starts it by itself, with the triggers'
 * switch, or what does not start it while they are off; when a schedule runs it
 * next; where it runs and at which step; and why it cannot run. What it types and
 * when it last ran are in the name's tooltip (#5757). The selected row shows
 * Edit; a "…" menu appears on hover or focus and on right-click. Double-click
 * opens the editor: only Run types into a terminal.
 */
export function AutomationRow({
  automation,
  targets,
  runs,
  runTarget,
  compact = false,
  blocked,
  nextRun,
  connectionName,
  resolve,
  onSetTriggers,
  actions,
  justSaved = false,
  rowProps,
}: AutomationRowProps) {
  const { id, name } = automation;
  const { ref, ...rovingProps } = rowProps;
  const running = targets.length > 0;
  const several = targets.length > 1;
  const waiting = targets.some((target) => target.waiting);
  const selected = rowProps.tabIndex === 0;
  const triggers = triggerState(automation, {
    connectionName,
    resolve,
    blocked: blocked !== null,
  });
  const failed = !running && runs?.failed === true;

  const runningText = waiting
    ? t("automation.marker.waiting")
    : several
      ? tf("automation.marker.runningCount", { count: targets.length })
      : t("automation.marker.running");
  // The line under the name says it in words, and the name keeps its room (C-008).
  const iconOnly = compact || several || waiting;
  // The row's own name says its state too, so moving through the list reads
  // "Deploy prep, Running" instead of every button inside the row.
  const rowLabel = [
    name,
    running ? runningText : null,
    blocked && !running ? t("automation.marker.blocked") : null,
    failed ? t("automation.marker.failed") : null,
    triggers
      ? t(
          !triggers.on
            ? "automation.triggers.offState"
            : triggers.effective
              ? "automation.triggers.onState"
              : "automation.triggers.noneState"
        )
      : null,
  ]
    .filter(Boolean)
    .join(", ");

  const menu = (
    <AutomationRowMenu
      automationId={id}
      running={running}
      blocked={blocked !== null}
      canUseInNew={isMacroShaped(automation)}
      actions={actions}
    />
  );

  const markers = (
    <>
      {running ? (
        <Tooltip content={runningText} side="top" disabled={!iconOnly}>
          <span
            className={
              waiting
                ? "automation-item__marker automation-item__marker--waiting"
                : "automation-item__marker automation-item__marker--running"
            }
            data-waiting={waiting ? "true" : undefined}
            data-testid={`automation-running-${id}`}
            role={iconOnly ? "img" : undefined}
            aria-label={iconOnly ? runningText : undefined}
          >
            {waiting ? <Hand size={10} aria-hidden="true" /> : <Spinner size={10} label={null} />}
            {iconOnly ? null : runningText}
          </span>
        </Tooltip>
      ) : null}
      {blocked && !running ? (
        <Tooltip content={tf("automation.blocked.label", { name })} side="top">
          <button
            type="button"
            className="automation-item__marker automation-item__marker--blocked"
            aria-label={tf("automation.blocked.label", { name })}
            data-testid={`automation-blocked-${id}`}
            {...keepOffRow}
            onClick={(e) => {
              e.stopPropagation();
              actions.onEdit(id);
            }}
          >
            <Ban size={10} aria-hidden="true" />
            {compact ? null : t("automation.marker.blocked")}
          </button>
        </Tooltip>
      ) : null}
      {failed ? (
        <Tooltip content={tf("automation.marker.failedLabel", { name })} side="top">
          <button
            type="button"
            className="automation-item__marker automation-item__marker--failed"
            aria-label={tf("automation.marker.failedLabel", { name })}
            data-testid={`automation-failed-${id}`}
            {...keepOffRow}
            onClick={(e) => {
              e.stopPropagation();
              actions.onShowHistory(id);
            }}
          >
            <AlertTriangle size={10} aria-hidden="true" />
            {compact ? null : t("automation.marker.failed")}
          </button>
        </Tooltip>
      ) : null}
    </>
  );

  const runControl = running ? (
    <Tooltip content="Stop" side="top" disabled={several}>
      <Button
        variant="ghost"
        size="sm"
        iconOnly={!several}
        aria-label={tf(several ? "automation.stop.allLabel" : "automation.stop.label", { name })}
        data-testid={`automation-stop-${id}`}
        icon={<Square size={12} fill="currentColor" />}
        onClick={(e) => {
          e.stopPropagation();
          actions.onStop(id);
        }}
      >
        {/* It ends every line below, so it says so (B-003). */}
        {several ? tf("automation.stop.all", { count: targets.length }) : null}
      </Button>
    </Tooltip>
  ) : blocked ? null : (
    <Tooltip
      content={
        runTarget
          ? tf("automation.run.target", { target: runTarget, keys: modKeyAccelerator("Enter") })
          : t("automation.run.noTarget")
      }
      side="top"
    >
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        aria-label={tf(runTarget ? "automation.run.label" : "automation.run.labelPick", { name })}
        data-testid={`automation-start-${id}`}
        icon={<Play size={12} />}
        onClick={(e) => {
          e.stopPropagation();
          actions.onRun(id);
        }}
      />
    </Tooltip>
  );

  // Always in the same place: pressing it focuses and so selects the row, and a
  // button that moved between press and release would never be clicked.
  const editButton = (
    <Tooltip content="Edit" side="top">
      <Button
        className={selected ? undefined : "automation-item__edit"}
        variant="ghost"
        size="sm"
        iconOnly
        aria-label={`Edit ${name}`}
        data-testid={`automation-edit-${id}`}
        icon={<Pencil size={12} />}
        onClick={(e) => {
          e.stopPropagation();
          actions.onEdit(id);
        }}
      />
    </Tooltip>
  );

  const details = (
    <RowLines
      id={id}
      name={name}
      targets={targets}
      blocked={running ? null : blocked}
      importedInPart={automation.importedInPart ?? []}
      missingCalleeStep={missingCalleeStep(automation, resolve)}
      onEdit={() => actions.onEdit(id)}
      triggers={triggers}
      nextRun={nextRun}
      onSetTriggers={(on) => onSetTriggers(id, on)}
    />
  );

  return (
    <ContextMenuRoot>
      <ContextMenuTrigger asChild>
        <SidebarListItem
          ref={ref}
          {...rovingProps}
          aria-label={rowLabel}
          className={[
            "automation-item",
            selected ? "automation-item--selected" : "",
            justSaved ? "automation-item--just-saved" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          data-just-saved={justSaved ? "true" : undefined}
          testId={`automation-item-${id}`}
          name={name}
          nameTestId={`automation-name-${id}`}
          description={automation.description}
          descriptionTestId={`automation-description-${id}`}
          tooltip={automationRowTooltip(automation, connectionName, runs?.last)}
          tooltipTestId={`automation-tooltip-${id}`}
          onDoubleClick={(e) => {
            // Only the row itself: not its buttons, and not its "…" menu, whose
            // events reach here through the React tree.
            const target = e.target as HTMLElement;
            if (!e.currentTarget.contains(target) || target.closest("button")) return;
            actions.onEdit(id);
          }}
          primaryActionTestId={`automation-primary-${id}`}
          primaryAction={
            <>
              {markers}
              {editButton}
              {runControl}
            </>
          }
          moreActionsLabel={tf("automation.more.label", { name })}
          moreActionsTestId={`automation-more-group-${id}`}
          actions={
            <>
              <DropdownMenuRoot>
                <Tooltip content="More actions" side="top">
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      aria-label={tf("automation.more.label", { name })}
                      data-testid={`automation-more-${id}`}
                      icon={<MoreHorizontal size={12} />}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </DropdownMenuTrigger>
                </Tooltip>
                <DropdownMenuContent align="end" sideOffset={4}>
                  {menu}
                </DropdownMenuContent>
              </DropdownMenuRoot>
            </>
          }
          details={details}
        />
      </ContextMenuTrigger>
      <ContextMenuContent>{menu}</ContextMenuContent>
    </ContextMenuRoot>
  );
}
