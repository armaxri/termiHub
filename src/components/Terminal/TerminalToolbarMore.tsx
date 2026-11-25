import type { ReactNode } from "react";
import { Check, CircleDot, MoreHorizontal, Play, Radio, ScrollText, Square } from "lucide-react";
import {
  Button,
  DropdownMenuContent,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  MenuCheckboxItem,
  MenuItem,
  MenuItemIndicator,
  MenuSeparator,
  Tooltip,
} from "@/components/ui";
import { t, tf } from "@/i18n/catalog";
import { getActionAccelerator, withActionAccelerator } from "@/services/keybindings";

/** Keeps the open menu this far from every window edge (same as the file browser menu, #5624). */
export const TERMINAL_MENU_EDGE_PADDING = 8;

/** Progress of a running automation, as the store reports it. */
export interface PlaybackProgress {
  played: number;
  total: number;
}

/** State and callbacks of the actions that live in the "…" menu. */
export interface TerminalToolbarMoreProps {
  broadcastActive: boolean;
  onToggleBroadcast: () => void;
  loggingActive: boolean;
  onToggleLogging: () => void;
  /** What the recording chip says; `null` while nothing is recorded. */
  recordingLabel: string | null;
  onToggleRecording: () => void;
  playback: PlaybackProgress | null;
  onRunAutomation: () => void;
  onStopPlayback: () => void;
}

/**
 * The session and automation half of the terminal toolbar (#5756): broadcast,
 * session logging, Record and Run automation are entries of one "…" menu,
 * each with its keyboard shortcut right-aligned (from the keybinding registry,
 * so it follows the platform and any user override).
 *
 * Session logging and recording are on/off states, so their rows are
 * checkbox rows (#5849, R-066): the label stays put ("Log session output") and
 * a tick plus `aria-checked` say whether it is on, instead of a row whose
 * wording flips and says nothing while off. Every row keeps a tick column so
 * the labels line up.
 *
 * An action that is running stays visible without opening the menu: it shows
 * as a labelled chip beside the layout icons ("Broadcasting", "Recording", …),
 * and a click on the chip stops it. A dot on "…" alone would say *something*
 * is on but not what, and broadcast mirrors every keystroke into other
 * terminals — the user must see that by name and be one click from stopping it.
 */
export function TerminalToolbarMore(props: TerminalToolbarMoreProps) {
  const {
    broadcastActive,
    onToggleBroadcast,
    loggingActive,
    onToggleLogging,
    recordingLabel,
    onToggleRecording,
    playback,
    onStopPlayback,
  } = props;
  const moreLabel = t("terminalToolbar.more");
  const activeCount =
    Number(broadcastActive) +
    Number(loggingActive) +
    Number(recordingLabel !== null) +
    Number(playback !== null);

  return (
    <>
      {activeCount > 0 && (
        <div
          className="terminal-view__active-states"
          role="group"
          aria-label="Running actions"
          data-testid="terminal-view-active-states"
        >
          {broadcastActive && (
            <ActiveChip
              label={t("terminalToolbar.chip.broadcast")}
              tooltip={withActionAccelerator(
                t("terminalToolbar.broadcast.stop"),
                "toggle-broadcast"
              )}
              icon={<Radio size={14} />}
              tone="broadcast"
              onClick={onToggleBroadcast}
              testId="terminal-view-active-broadcast"
            />
          )}
          {recordingLabel !== null && (
            <ActiveChip
              label={recordingLabel}
              tooltip={withActionAccelerator(
                t("terminalToolbar.record.stop"),
                "toggle-macro-recording"
              )}
              icon={<Square size={12} fill="currentColor" />}
              tone="recording"
              onClick={onToggleRecording}
              testId="terminal-view-active-recording"
            />
          )}
          {playback && (
            <ActiveChip
              label={tf("terminalToolbar.chip.playback", {
                played: playback.played,
                total: playback.total,
              })}
              tooltip={withActionAccelerator(
                tf("terminalToolbar.play.stop", {
                  played: playback.played,
                  total: playback.total,
                }),
                "play-macro"
              )}
              icon={<Square size={12} fill="currentColor" />}
              tone="recording"
              onClick={onStopPlayback}
              testId="terminal-view-active-playback"
            />
          )}
          {loggingActive && (
            <ActiveChip
              label={t("terminalToolbar.chip.logging")}
              tooltip={withActionAccelerator(
                t("terminalToolbar.logging.stop"),
                "toggle-session-logging"
              )}
              icon={<ScrollText size={14} />}
              tone="active"
              onClick={onToggleLogging}
              testId="terminal-view-active-logging"
            />
          )}
        </div>
      )}
      <DropdownMenuRoot>
        <Tooltip content={moreLabel} side="bottom">
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={<MoreHorizontal size={16} />}
              aria-label={moreLabel}
              data-active-count={activeCount}
              data-testid="terminal-view-more-actions"
            />
          </DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent
          align="end"
          side="bottom"
          sideOffset={4}
          collisionPadding={TERMINAL_MENU_EDGE_PADDING}
          data-testid="terminal-view-more-menu"
        >
          <MoreMenuItems {...props} />
        </DropdownMenuContent>
      </DropdownMenuRoot>
    </>
  );
}

/**
 * The menu's rows. Rendered only while the menu is open, so each opening reads
 * the current shortcut bindings.
 */
function MoreMenuItems({
  broadcastActive,
  onToggleBroadcast,
  loggingActive,
  onToggleLogging,
  recordingLabel,
  onToggleRecording,
  playback,
  onRunAutomation,
  onStopPlayback,
}: TerminalToolbarMoreProps) {
  return (
    <>
      <MenuItem
        icon={<RowIcon icon={<Radio size={14} />} />}
        shortcut={getActionAccelerator("toggle-broadcast")}
        onSelect={onToggleBroadcast}
        data-active={broadcastActive}
        data-testid="terminal-view-broadcast"
      >
        {broadcastActive
          ? t("terminalToolbar.broadcast.stop")
          : t("terminalToolbar.broadcast.start")}
      </MenuItem>
      <MenuCheckboxItem
        icon={<RowIcon toggle icon={<ScrollText size={14} />} />}
        shortcut={getActionAccelerator("toggle-session-logging")}
        checked={loggingActive}
        onSelect={onToggleLogging}
        data-active={loggingActive}
        data-testid="terminal-view-toggle-logging"
      >
        {t("terminalToolbar.logging.start")}
      </MenuCheckboxItem>
      <MenuSeparator />
      <MenuCheckboxItem
        icon={<RowIcon toggle icon={<CircleDot size={14} />} />}
        shortcut={getActionAccelerator("toggle-macro-recording")}
        checked={recordingLabel !== null}
        onSelect={onToggleRecording}
        data-active={recordingLabel !== null}
        data-testid="terminal-view-record"
      >
        {t("terminalToolbar.record.start")}
      </MenuCheckboxItem>
      <MenuItem
        icon={
          <RowIcon
            icon={playback ? <Square size={12} fill="currentColor" /> : <Play size={14} />}
          />
        }
        shortcut={getActionAccelerator("play-macro")}
        onSelect={playback ? onStopPlayback : onRunAutomation}
        data-active={playback !== null}
        data-testid="terminal-view-run-automation"
      >
        {playback
          ? tf("terminalToolbar.play.stop", {
              played: playback.played,
              total: playback.total,
            })
          : t("terminalToolbar.play.start")}
      </MenuItem>
    </>
  );
}

/**
 * A row's leading column: the tick slot, then the action's icon. The slot is
 * filled only on a checked toggle row; on every other row it stays empty so
 * all labels line up.
 */
function RowIcon({ icon, toggle = false }: { icon: ReactNode; toggle?: boolean }) {
  return (
    <>
      <span className="ui-menu__indicator" aria-hidden>
        {toggle && (
          <MenuItemIndicator>
            <Check size={14} />
          </MenuItemIndicator>
        )}
      </span>
      {icon}
    </>
  );
}

/** A running action, named, that stops it on click. */
function ActiveChip({
  label,
  tooltip,
  icon,
  tone,
  onClick,
  testId,
}: {
  label: string;
  tooltip: string;
  icon: ReactNode;
  tone: "broadcast" | "recording" | "active";
  onClick: () => void;
  testId: string;
}) {
  return (
    <Tooltip content={tooltip} side="bottom">
      <Button
        variant="ghost"
        size="sm"
        icon={icon}
        className={`terminal-view__state-chip terminal-view__state-chip--${tone}`}
        onClick={onClick}
        aria-label={tooltip}
        data-testid={testId}
      >
        {label}
      </Button>
    </Tooltip>
  );
}
