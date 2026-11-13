import { useRef } from "react";
import { Monitor } from "lucide-react";
import { ConnectProgress } from "@/components/ui/ConnectProgress";
import { connectTypeLabel } from "@/utils/connectStages";
import { ConnectFailureActions } from "@/components/Terminal/ConnectFailure";
import { graphicalStages } from "./graphicalStages";

interface RemoteDesktopFirstFrameOverlayProps {
  host: string;
  /** `"rdp"` or `"vnc"`, for the type chip. */
  protocol: string;
  /** `user@host` of the SSH gateway for a tunnelled session, else `null`. */
  via: string | null;
  /** No frame painted within the first-frame timeout. */
  timedOut: boolean;
  /** Reconnect from scratch. */
  onRetry: () => void;
  /** Open the saved connection's editor; omitted for an unsaved tab. */
  onEditConnection?: () => void;
  onCloseTab: () => void;
  /** Focus Retry when the timeout error appears on the visible tab. */
  isActive?: boolean;
}

const NO_FRAME_HINT =
  "The session is connected, but the server has sent no picture. The server may be " +
  "stuck or showing nothing — retry, or check the connection's display settings.";

/**
 * Overlay for a graphical session that is up but has not painted a frame yet
 * (#5626): the connect stepper with the first-frame step active, so the tab is
 * never a blank pane, then — after the timeout — a "No picture" resting state
 * with Retry, Edit connection and Close tab.
 */
export function RemoteDesktopFirstFrameOverlay({
  host,
  protocol,
  via,
  timedOut,
  onRetry,
  onEditConnection,
  onCloseTab,
  isActive = false,
}: RemoteDesktopFirstFrameOverlayProps) {
  const startedAt = useRef(Date.now()).current;
  const common = {
    target: host,
    typeLabel: connectTypeLabel(protocol),
    typeIcon: <Monitor size={20} aria-hidden />,
    details: via ? [`via SSH ${via}`] : undefined,
    startedAt,
  };

  if (timedOut) {
    const heading = "No picture from the remote desktop";
    return (
      <div className="rd-overlay" data-testid="remote-desktop-overlay-no-frame">
        <ConnectProgress
          {...common}
          phase="timeout"
          heading={heading}
          stages={graphicalStages("firstFrame", via !== null, true)}
          error={NO_FRAME_HINT}
          announcement={`${heading}. ${host}: ${NO_FRAME_HINT}`}
          autoFocusPrimaryAction={isActive}
          timeText=""
          actions={
            <ConnectFailureActions
              onRetry={onRetry}
              onEdit={onEditConnection}
              onClose={onCloseTab}
              testIds={{
                retry: "remote-desktop-first-frame-retry",
                edit: "remote-desktop-first-frame-edit",
                close: "remote-desktop-first-frame-close-tab",
              }}
            />
          }
        />
      </div>
    );
  }

  const status = "Connected, waiting for the first frame…";
  return (
    <div className="rd-overlay" data-testid="remote-desktop-overlay-first-frame">
      <ConnectProgress
        {...common}
        phase="connecting"
        heading={`Connecting to ${host}…`}
        stages={graphicalStages("firstFrame", via !== null)}
        status={status}
        announcement={`${host}: ${status}`}
      />
    </div>
  );
}
