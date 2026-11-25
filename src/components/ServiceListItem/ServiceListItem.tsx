import type React from "react";
import {
  Activity,
  Clipboard,
  Copy,
  Ellipsis,
  ExternalLink,
  Pencil,
  Play,
  RefreshCw,
  RotateCw,
  Square,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { writeText as writeClipboard } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Button,
  ContextMenuContent,
  ContextMenuRoot,
  ContextMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  MenuItem,
  MenuSeparator,
  StatusDot,
  toast,
  Tooltip,
} from "@/components/ui";
import { SidebarListItem } from "@/components/SidebarListItem";
import { errorMessage } from "@/utils/errorMessage";
import { fireAndForget } from "@/utils/frontendLog";
import { t, tf } from "@/i18n/catalog";
import type { ServiceAction, ServiceActionId, ServiceModel } from "@/utils/serviceModel";
import { serviceStateDot, serviceStateLabel } from "@/utils/serviceState";
import { serviceRowTestIds, type ServiceActionTestIds } from "./serviceRowTestIds";
import "./ServiceListItem.css";

/** What the owner of the service does; the row copies and opens by itself. */
export type ServiceRowAction = Exclude<ServiceActionId, "copyAddress" | "openInBrowser">;

export interface ServiceListItemProps {
  model: ServiceModel;
  /** Tooltip lines of the row (see docs/copy-style.md -> "List rows"). */
  tooltip: readonly string[];
  /** Run one of the row's actions. May be async: its button shows it. */
  onAction: (id: ServiceRowAction) => void | Promise<void>;
  /** Take the next step the model names. */
  onNextStep?: () => void;
  /** Lines of one kind only, under the shared ones. */
  extras?: React.ReactNode;
  /** The open Activity, when it is open. */
  activity?: React.ReactNode;
  /** Beside the name, e.g. the mark of a chained hop. */
  nameMark?: React.ReactNode;
  className?: string;
  /** Roving-tabindex ref wiring the row into the sidebar's keyboard navigation. */
  rowRef?: (el: HTMLDivElement | null) => void;
  /** Roving-tabindex row props (role, tabIndex, aria-level, onFocus). */
  rowProps?: React.HTMLAttributes<HTMLDivElement>;
}

const ICONS: Record<ServiceActionId, LucideIcon> = {
  start: Play,
  stop: Square,
  stopWaiting: Square,
  retry: RotateCw,
  copyAddress: Clipboard,
  openInBrowser: ExternalLink,
  activity: Activity,
  edit: Pencil,
  restart: RefreshCw,
  duplicate: Copy,
  delete: Trash2,
};

/** The run control, always visible on the row's trailing edge (#5852). */
const RUN: ReadonlySet<ServiceActionId> = new Set(["start", "stop", "stopWaiting", "retry"]);
/** On the row, revealed on hover and focus; the rest is in its "…" menu. */
const ON_ROW: ReadonlySet<ServiceActionId> = new Set(["activity", "edit"]);
/** Keys that move in the list. */
const MOVES: ReadonlySet<string> = new Set(["ArrowUp", "ArrowDown", "Home", "End"]);
/** In the menu, a line goes before these. */
const GROUP_STARTS: ReadonlySet<ServiceActionId> = new Set(["activity", "edit", "delete"]);

/**
 * The row of a service, an SSH tunnel or a file server (#6028): what it is and
 * where, its state in words, the address with Copy while it runs, or why it does
 * not, and its run control. Everything it says and offers is in the
 * {@link ServiceModel}; this only lays it out.
 *
 * Keys on the focused row: Space runs the run control, Delete deletes, Enter
 * edits (the list's own navigation).
 */
export function ServiceListItem({
  model,
  tooltip,
  onAction,
  onNextStep,
  extras,
  activity,
  nameMark,
  className,
  rowRef,
  rowProps,
}: ServiceListItemProps) {
  const ids = serviceRowTestIds(model.kind, model.id);
  const { address } = model;
  const run = model.actions.find((action) => RUN.has(action.id));

  const copyAddress = async () => {
    if (address) await writeClipboard(address.copy);
  };

  /** Do `action`; rejects when it fails, after the user was told. */
  const perform = async (id: ServiceActionId): Promise<void> => {
    if (id === "copyAddress") {
      try {
        await copyAddress();
      } catch (err) {
        toast.error("Failed to copy the address", { description: errorMessage(err) });
        throw err;
      }
    } else if (id === "openInBrowser") {
      if (address) fireAndForget(openUrl(address.copy), `open ${address.copy} in browser`);
    } else {
      await onAction(id);
    }
  };

  /** From a menu or a key there is no button to show the failure, which was shown. */
  const performQuietly = (id: ServiceActionId) =>
    fireAndForget(perform(id), `${id} service ${model.id}`);

  const performFromMenu = (id: ServiceActionId) => {
    if (id !== "copyAddress") return performQuietly(id);
    const copied = perform(id).then(() =>
      // toast-policy: no-in-place-surface — the address is on the clipboard
      toast.success(t("service.addressCopied"))
    );
    fireAndForget(copied, `copy the address of service ${model.id}`);
  };

  const button = (action: ServiceAction): React.ReactNode => {
    const Icon = ICONS[action.id];
    return (
      <Tooltip key={action.id} content={action.label} side="top">
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={action.label}
          aria-pressed={action.id === "activity" ? activity !== undefined : undefined}
          {...ids.actionTestIds[action.id]}
          icon={<Icon size={12} />}
          // Whoever acts shows its own failure.
          errorToast={false}
          onClick={(e) => {
            e.stopPropagation();
            return perform(action.id);
          }}
        />
      </Tooltip>
    );
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) {
      // Keys on a button inside are the button's: the list would take its Enter
      // and edit. Moving on from it is the list's, but not out of the open menu.
      const inside = e.currentTarget.contains(e.target as Node);
      if (inside && MOVES.has(e.key)) rowProps?.onKeyDown?.(e);
      else e.stopPropagation();
      return;
    }
    if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key !== "Enter") {
      const wanted = e.key === " " ? "Space" : e.key;
      const action = model.actions.find((a) => a.shortcut === wanted);
      if (action) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) performQuietly(action.id);
        return;
      }
    }
    rowProps?.onKeyDown?.(e);
  };

  const onRow = model.actions.filter((action) => ON_ROW.has(action.id));
  const copy = model.actions.find((action) => action.id === "copyAddress");
  const shortcuts = [...new Set(model.actions.flatMap((a) => a.shortcut ?? []))].join(" ");

  /** Every action, in the model's order. */
  const menuItems = (testIds: ServiceActionTestIds) =>
    model.actions.map((action, index) => {
      const Icon = ICONS[action.id];
      return (
        <MenuEntry key={action.id} separated={index > 0 && GROUP_STARTS.has(action.id)}>
          <MenuItem
            danger={action.id === "delete"}
            onSelect={() => performFromMenu(action.id)}
            {...testIds[action.id]}
          >
            <Icon size={14} /> {action.label}
          </MenuItem>
        </MenuEntry>
      );
    });

  const moreMenu = (
    <DropdownMenuRoot>
      <Tooltip content={t("service.more")} side="top">
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={t("service.more")}
            data-testid={ids.moreTestId}
            icon={<Ellipsis size={12} />}
            onClick={(e) => e.stopPropagation()}
          />
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        {menuItems(ids.moreItemTestIds)}
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );

  const details = (
    <>
      <span className="service-row__kind" data-testid={ids.kindTestId}>
        <span
          className="service-row__state"
          data-state={model.state}
          // The dot beside the name says it.
          aria-hidden="true"
        >
          {serviceStateLabel(model.state)}
        </span>
        {" · "}
        {model.kindLine}
      </span>
      {address && (
        <span className="service-row__address" data-testid={ids.addressTestId}>
          <span className="service-row__address-text">
            <code>{address.copy}</code>
            {address.on && ` ${tf("service.address.onMachine", { machine: address.on })}`}
          </span>
          {copy && button(copy)}
        </span>
      )}
      {model.reason && (
        <span
          className="service-row__reason"
          data-state={model.state}
          data-testid={ids.reasonTestId}
        >
          {model.reason}
          {model.nextStep && onNextStep && (
            <>
              {" "}
              <button
                type="button"
                className="service-row__next"
                data-testid={ids.nextStepTestId}
                onClick={(e) => {
                  e.stopPropagation();
                  onNextStep();
                }}
              >
                {model.nextStep.label}
              </button>
            </>
          )}
        </span>
      )}
      {extras}
      {activity}
    </>
  );

  return (
    <ContextMenuRoot>
      <ContextMenuTrigger asChild>
        <SidebarListItem
          ref={rowRef}
          {...rowProps}
          aria-keyshortcuts={shortcuts}
          onKeyDown={onKeyDown}
          className={["service-row", className ?? ""].filter(Boolean).join(" ")}
          testId={ids.rowTestId}
          nameTestId={ids.nameTestId}
          name={
            nameMark ? (
              <span className="service-row__marked-name">
                {nameMark}
                {model.name}
              </span>
            ) : (
              model.name
            )
          }
          onDoubleClick={() => performQuietly("edit")}
          status={<StatusDot {...serviceStateDot(model.state)} testId={ids.statusTestId} />}
          description={model.description}
          descriptionTestId={ids.descriptionTestId}
          tooltip={tooltip}
          tooltipTestId={ids.tooltipTestId}
          primaryAction={run && button(run)}
          primaryActionTestId={ids.primaryTestId}
          moreActionsLabel={tf("service.moreActions", { name: model.name })}
          actions={
            <>
              {onRow.map(button)}
              {moreMenu}
            </>
          }
          details={details}
        />
      </ContextMenuTrigger>
      <ContextMenuContent
        aria-label={t("service.menu")}
        // Its keys are its own, not the list's.
        onKeyDown={(e) => e.stopPropagation()}
      >
        {menuItems(ids.menuTestIds)}
      </ContextMenuContent>
    </ContextMenuRoot>
  );
}

interface MenuEntryProps {
  separated: boolean;
  children: React.ReactNode;
}

/** A menu item, with the line before its group. */
function MenuEntry({ separated, children }: MenuEntryProps) {
  return (
    <>
      {separated && <MenuSeparator />}
      {children}
    </>
  );
}
