import {
  Monitor,
  Keyboard,
  Clipboard,
  Scaling,
  Maximize,
  EyeOff,
  LogOut,
  Columns2,
  FolderOpen,
} from "lucide-react";
import { Button } from "@/components/ui";
import type { MonitorRect, ScaleMode } from "@/types/remoteDesktop";
import { SCALE_MODE_LABELS } from "@/types/remoteDesktop";
import { monitorLabel } from "./monitorLayout";
import { useReleaseChordLabel } from "./releaseChord";

interface RemoteDesktopToolbarProps {
  /** Host label (badge). */
  host: string;
  /** Current framebuffer resolution, or null before the first frame. */
  resolution: { width: number; height: number } | null;
  /** Whether the session is view-only (shows the badge, hides input actions). */
  viewOnly: boolean;
  /** Active scale mode (the button cycles through the three). */
  scaleMode: ScaleMode;
  onSendCtrlAltDel: () => void;
  onToggleClipboard: () => void;
  onCycleScaleMode: () => void;
  onToggleFullscreen: () => void;
  onDisconnect: () => void;
  /**
   * The session's monitors in framebuffer coordinates (#3696). With two or
   * more, the viewport selector cycles "All monitors" → "Monitor 1" → … .
   */
  monitors?: MonitorRect[];
  /** The shown monitor's index, or `null` for all monitors. */
  viewport?: number | null;
  /** Advance the viewport selector: all → monitor 1 → … → all. */
  onCycleViewport?: () => void;
  /**
   * The Files button (#4192): `hidden` (view-only or no handler), `disabled`
   * (no file route — {@link filesTitle} says why), `active`, or `warning`
   * (the route's host refused, e.g. SFTP disabled — a warning dot).
   */
  filesButton?: FilesButtonState;
  /** Tooltip of the Files button (the reason when disabled or warning). */
  filesTitle?: string;
  /** Whether the Files popover is open. */
  filesOpen?: boolean;
  onToggleFiles?: () => void;
}

/** The Files button's state. */
export type FilesButtonState = "hidden" | "disabled" | "active" | "warning";

/** The viewport selector's current label. */
function viewportTitle(monitors: MonitorRect[], viewport: number | null): string {
  const current =
    viewport === null || !monitors[viewport]
      ? `All monitors (${monitors.length})`
      : monitorLabel(monitors[viewport], viewport);
  return `Showing: ${current}`;
}

/**
 * The one shared floating hover toolbar for graphical remote-desktop sessions
 * (#1680) — host badge, resolution, Ctrl+Alt+Del, clipboard, files (#4192), scaling, the
 * multi-monitor viewport selector (#3696), fullscreen, disconnect. Identical for every protocol; auto-hides via CSS when
 * the pointer leaves the surface. Icon actions compose from the shared `Button`
 * primitive (icon-only ghost).
 */
export function RemoteDesktopToolbar({
  host,
  resolution,
  viewOnly,
  scaleMode,
  onSendCtrlAltDel,
  onToggleClipboard,
  onCycleScaleMode,
  onToggleFullscreen,
  onDisconnect,
  monitors = [],
  viewport = null,
  onCycleViewport,
  filesButton = "hidden",
  filesTitle = "Files",
  filesOpen = false,
  onToggleFiles,
}: RemoteDesktopToolbarProps) {
  const releaseChord = useReleaseChordLabel();
  return (
    <div className="rd-toolbar" data-testid="remote-desktop-toolbar">
      <span className="rd-toolbar__host">
        <Monitor size={14} />
        {host}
      </span>
      <span
        className="rd-toolbar__hint"
        title={`Press ${releaseChord} to return keyboard focus to termiHub`}
        data-testid="remote-desktop-release-hint"
      >
        <kbd>{releaseChord}</kbd> release keyboard
      </span>
      {resolution && (
        <span className="rd-toolbar__res">
          {resolution.width}×{resolution.height}
        </span>
      )}
      {!viewOnly && (
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon={<Keyboard size={14} />}
          title="Send Ctrl+Alt+Del"
          onClick={onSendCtrlAltDel}
          data-testid="remote-desktop-cad"
        />
      )}
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        icon={<Clipboard size={14} />}
        title="Clipboard"
        onClick={onToggleClipboard}
        data-testid="remote-desktop-clipboard-btn"
      />
      {filesButton !== "hidden" && onToggleFiles && (
        <span className="rd-toolbar__files" title={filesTitle}>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<FolderOpen size={14} />}
            title={filesTitle}
            aria-label="Files"
            aria-pressed={filesOpen}
            disabled={filesButton === "disabled"}
            onClick={onToggleFiles}
            data-testid="remote-desktop-files-btn"
            data-state={filesButton}
          />
          {filesButton === "warning" && (
            <span className="rd-toolbar__dot" data-testid="remote-desktop-files-warning" />
          )}
        </span>
      )}
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        icon={<Scaling size={14} />}
        title={`Scaling: ${SCALE_MODE_LABELS[scaleMode]}`}
        onClick={onCycleScaleMode}
        data-testid="remote-desktop-scale"
      />
      {monitors.length >= 2 && onCycleViewport && (
        <Button
          variant="ghost"
          size="sm"
          icon={<Columns2 size={14} />}
          title={viewportTitle(monitors, viewport)}
          aria-label={viewportTitle(monitors, viewport)}
          onClick={onCycleViewport}
          data-testid="remote-desktop-monitor"
        >
          {viewport === null ? "All" : `${viewport + 1}/${monitors.length}`}
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        icon={<Maximize size={14} />}
        title="Fullscreen"
        onClick={onToggleFullscreen}
        data-testid="remote-desktop-fullscreen"
      />
      <Button
        variant="danger"
        size="sm"
        iconOnly
        icon={<LogOut size={14} />}
        title="Disconnect"
        onClick={onDisconnect}
        data-testid="remote-desktop-disconnect"
      />
      {viewOnly && (
        <span className="rd-toolbar__badge" data-testid="remote-desktop-viewonly">
          <EyeOff size={14} />
          View only
        </span>
      )}
    </div>
  );
}
