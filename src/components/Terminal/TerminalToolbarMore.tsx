import type { ReactNode } from "react";
import { CircleDot, MoreHorizontal, Play, Radio, ScrollText, Square } from "lucide-react";
import {
  Button,
  DropdownMenuContent,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  MenuItem,
  MenuSeparator,
  Tooltip,
} from "@/components/ui";
import { t, tf } from "@/i18n/catalog";
import { getActionAccelerator, withActionAccelerator } from "@/services/keybindings";

/** Keeps the open menu this far from every window edge (same as the file browser menu, #5624). */
export const TERMINAL_MENU_EDGE_PADDING = 8;

/** Progress of a running macro playback, as the store reports it. */
export interface MacroPlaybackProgress {
  played: number;
  total: number;
}

/** State and callbacks of the actions that live in the "…" menu. */
export interface TerminalToolbarMoreProps {
  broadcastActive: boolean;
  onToggleBroadcast: () => void;
  loggingActive: boolean;
  onToggleLogging: () => void;
  macroRecording: boolean;
  onToggleRecording: () => void;
  macroPlayback: MacroPlaybackProgress | null;
  onPlayMacro: () => void;
  onStopPlayback: () => void;
}

/**
 * The session and macro half of the terminal toolbar (#5756): broadcast,
 * session logging, macro record and macro play are entries of one "…" menu,
 * each with its keyboard shortcut right-aligned (from the keybinding registry,
 * so it follows the platform and any user override).
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
    macroRecording,
    onToggleRecording,
    macroPlayback,
    onStopPlayback,
  } = props;
  const moreLabel = t("terminalToolbar.more");
  const activeCount =
    Number(broadcastActive) +
    Number(loggingActive) +
    Number(macroRecording) +
    Number(macroPlayback !== null);

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
          {macroRecording && (
            <ActiveChip
              label={t("terminalToolbar.chip.recording")}
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
          {macroPlayback && (
            <ActiveChip
              label={tf("terminalToolbar.chip.playback", {
                played: macroPlayback.played,
                total: macroPlayback.total,
              })}
              tooltip={tf("terminalToolbar.play.stop", {
                played: macroPlayback.played,
                total: macroPlayback.total,
              })}
              icon={<Square size={12} fill="currentColor" />}
              tone="recording"
              onClick={onStopPlayback}
              testId="terminal-view-active-playback"
            />
          )}
          {loggingActive && (
            <ActiveChip
              label={t("terminalToolbar.chip.logging")}
              tooltip={t("terminalToolbar.logging.stop")}
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
  macroRecording,
  onToggleRecording,
  macroPlayback,
  onPlayMacro,
  onStopPlayback,
}: TerminalToolbarMoreProps) {
  return (
    <>
      <MenuItem
        icon={<Radio size={14} />}
        shortcut={getActionAccelerator("toggle-broadcast")}
        onSelect={onToggleBroadcast}
        data-active={broadcastActive}
        data-testid="terminal-view-broadcast"
      >
        {broadcastActive
          ? t("terminalToolbar.broadcast.stop")
          : t("terminalToolbar.broadcast.start")}
      </MenuItem>
      <MenuItem
        icon={<ScrollText size={14} />}
        onSelect={onToggleLogging}
        data-active={loggingActive}
        data-testid="terminal-view-toggle-logging"
      >
        {loggingActive ? t("terminalToolbar.logging.stop") : t("terminalToolbar.logging.start")}
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        icon={macroRecording ? <Square size={12} fill="currentColor" /> : <CircleDot size={14} />}
        shortcut={getActionAccelerator("toggle-macro-recording")}
        onSelect={onToggleRecording}
        data-active={macroRecording}
        data-testid="terminal-view-record-macro"
      >
        {macroRecording ? t("terminalToolbar.record.stop") : t("terminalToolbar.record.start")}
      </MenuItem>
      <MenuItem
        icon={macroPlayback ? <Square size={12} fill="currentColor" /> : <Play size={14} />}
        onSelect={macroPlayback ? onStopPlayback : onPlayMacro}
        data-active={macroPlayback !== null}
        data-testid="terminal-view-play-macro"
      >
        {macroPlayback
          ? tf("terminalToolbar.play.stop", {
              played: macroPlayback.played,
              total: macroPlayback.total,
            })
          : t("terminalToolbar.play.start")}
      </MenuItem>
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
