import { Monitor, Keyboard, Clipboard, Scaling, Maximize, EyeOff, LogOut } from "lucide-react";
import { Button } from "@/components/ui";
import type { ScaleMode } from "@/types/remoteDesktop";
import { SCALE_MODE_LABELS } from "@/types/remoteDesktop";

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
}

/**
 * The one shared floating hover toolbar for graphical remote-desktop sessions
 * (#1680) — host badge, resolution, Ctrl+Alt+Del, clipboard, scaling,
 * fullscreen, disconnect. Identical for every protocol; auto-hides via CSS when
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
}: RemoteDesktopToolbarProps) {
  return (
    <div className="rd-toolbar" data-testid="remote-desktop-toolbar">
      <span className="rd-toolbar__host">
        <Monitor size={14} />
        {host}
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
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        icon={<Scaling size={14} />}
        title={`Scaling: ${SCALE_MODE_LABELS[scaleMode]}`}
        onClick={onCycleScaleMode}
        data-testid="remote-desktop-scale"
      />
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
