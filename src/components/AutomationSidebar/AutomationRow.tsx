import React from "react";
import { AlertTriangle, MoreHorizontal, Pencil, Play, Square, Zap, ZapOff } from "lucide-react";
import {
  Button,
  ContextMenuContent,
  ContextMenuRoot,
  ContextMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  Spinner,
  Toggle,
  Tooltip,
} from "@/components/ui";
import { SidebarListItem } from "@/components/SidebarListItem";
import type { FlatRovingItemProps } from "@/hooks/useFlatRovingNav";
import { t, tf } from "@/i18n/catalog";
import { isMacroShaped } from "@/store/slices/automationViews";
import type { Automation } from "@/types/generated/Automation";
import {
  armedMarkerDescription,
  automationRowTooltip,
  automaticTriggers,
  triggersArmed,
  type AutomationRunSummary,
  type ConnectionName,
} from "./automationRowInfo";
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
  /** Steps done so far. */
  completed: number;
  /** Steps in all. */
  total: number;
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
  /** Resolves a saved connection id to its name, for triggers. */
  connectionName: ConnectionName;
  /** Arm or disarm its automatic triggers (#5674). */
  onSetArmed: (automationId: string, armed: boolean) => void;
  /** Every other action. */
  actions: AutomationRowActions;
  /** It was just saved: tint the row briefly (#5687). */
  justSaved?: boolean;
  /** Roving-tabindex props of the row (ref included). */
  rowProps: FlatRovingItemProps<HTMLDivElement>;
}

/** Keep a control's clicks and Enter/Space off the row, which runs on them. */
const keepOffRow = {
  onClick: (e: React.SyntheticEvent) => e.stopPropagation(),
  onDoubleClick: (e: React.SyntheticEvent) => e.stopPropagation(),
  onKeyDown: (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") e.stopPropagation();
  },
};

/**
 * One automation in the sidebar: the name (what users scan and search for,
 * #5519), the user's description when there is one, compact state markers
 * (Armed/Off with its switch, Running, Failed) and a Run control that is always
 * visible and becomes Stop while it runs (#5636, R-075). No settings: how it is
 * launched, what it types and when it last ran are in the name's tooltip
 * (#5757). Edit and a "…" menu appear on hover or focus; the same menu opens on
 * right-click. Double-click or Enter runs it.
 */
export function AutomationRow({
  automation,
  targets,
  runs,
  runTarget,
  compact = false,
  connectionName,
  onSetArmed,
  actions,
  justSaved = false,
  rowProps,
}: AutomationRowProps) {
  const { id, name } = automation;
  const { ref, ...rovingProps } = rowProps;
  const running = targets.length > 0;
  const several = targets.length > 1;
  const automatic = automaticTriggers(automation).length > 0;
  const armed = triggersArmed(automation);
  const failed = !running && runs?.failedUnattended === true;
  const armedDescription = automatic ? armedMarkerDescription(automation, connectionName) : "";

  const runningText = several
    ? tf("automation.marker.runningCount", { count: targets.length })
    : t("automation.marker.running");
  const armedText = armed ? t("automation.marker.armed") : t("automation.marker.off");
  // The row's own name says its state too, so moving through the list reads
  // "Deploy prep, Running" instead of every button inside the row.
  const rowLabel = [
    name,
    running ? runningText : null,
    failed ? t("automation.marker.failed") : null,
    automatic ? armedText : null,
  ]
    .filter(Boolean)
    .join(", ");

  const menu = (
    <AutomationRowMenu
      automationId={id}
      running={running}
      canUseInNew={isMacroShaped(automation)}
      actions={actions}
    />
  );

  const markers = (
    <>
      {running ? (
        <Tooltip content={runningText} side="top" disabled={!compact}>
          <span
            className="automation-item__marker automation-item__marker--running"
            data-testid={`automation-running-${id}`}
            role={compact ? "img" : undefined}
            aria-label={compact ? runningText : undefined}
          >
            <Spinner size={10} label={null} />
            {compact ? null : runningText}
          </span>
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
      {automatic ? (
        <>
          <Tooltip content={armedDescription} side="top">
            <span
              className={
                armed
                  ? "automation-item__marker automation-item__marker--armed"
                  : "automation-item__marker automation-item__marker--off"
              }
              role="img"
              aria-label={armedDescription}
              data-testid={`automation-armed-${id}`}
              data-armed={armed ? "true" : "false"}
            >
              {armed ? (
                <Zap size={10} aria-hidden="true" />
              ) : (
                <ZapOff size={10} aria-hidden="true" />
              )}
              {compact ? null : <span aria-hidden="true">{armedText}</span>}
            </span>
          </Tooltip>
          <span className="automation-item__arm-toggle" {...keepOffRow}>
            <Toggle
              checked={armed}
              onCheckedChange={(next) => onSetArmed(id, next)}
              aria-label={tf(armed ? "automation.armed.toggleOff" : "automation.armed.toggleOn", {
                name,
              })}
              data-testid={`automation-arm-toggle-${id}`}
            />
          </span>
        </>
      ) : null}
    </>
  );

  const runControl = running ? (
    <Tooltip content={several ? "Stop all" : "Stop"} side="top">
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        aria-label={tf(several ? "automation.stop.allLabel" : "automation.stop.label", { name })}
        data-testid={`automation-stop-${id}`}
        icon={<Square size={12} fill="currentColor" />}
        onClick={(e) => {
          e.stopPropagation();
          actions.onStop(id);
        }}
      />
    </Tooltip>
  ) : (
    <Tooltip
      content={
        runTarget
          ? tf("automation.run.target", { target: runTarget })
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

  return (
    <ContextMenuRoot>
      <ContextMenuTrigger asChild>
        <SidebarListItem
          ref={ref}
          {...rovingProps}
          aria-label={rowLabel}
          className={justSaved ? "automation-item automation-item--just-saved" : "automation-item"}
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
            if (!running) actions.onRun(id);
          }}
          primaryActionTestId={`automation-primary-${id}`}
          primaryAction={
            <>
              {markers}
              {runControl}
            </>
          }
          moreActionsLabel={tf("automation.more.label", { name })}
          moreActionsTestId={`automation-more-group-${id}`}
          actions={
            <>
              <Tooltip content="Edit" side="top">
                <Button
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
          details={
            several ? (
              <ul
                className="automation-item__targets"
                aria-label="Running terminals"
                data-testid={`automation-targets-${id}`}
              >
                {targets.map((target) => (
                  <li
                    key={target.key}
                    className="automation-item__target"
                    data-testid={`automation-target-${target.key}`}
                  >
                    <span className="automation-item__target-name">{target.label}</span>
                    <span className="automation-item__target-progress">
                      {target.completed} / {target.total}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      aria-label={tf("automation.stop.target", { target: target.label })}
                      data-testid={`automation-target-stop-${target.key}`}
                      icon={<Square size={10} fill="currentColor" />}
                      onClick={(e) => {
                        e.stopPropagation();
                        target.onStop();
                      }}
                    />
                  </li>
                ))}
              </ul>
            ) : null
          }
        />
      </ContextMenuTrigger>
      <ContextMenuContent>{menu}</ContextMenuContent>
    </ContextMenuRoot>
  );
}
