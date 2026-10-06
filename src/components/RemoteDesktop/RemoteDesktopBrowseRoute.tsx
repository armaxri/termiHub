import { AlertTriangle, MonitorUp } from "lucide-react";
import {
  browseSourceForSession,
  useRemoteDesktopBrowseStore,
} from "@/store/remoteDesktopBrowseStore";
import { browseRoute } from "./fileTransfer";
import "./RemoteDesktopBrowseRoute.css";

interface RemoteDesktopBrowseRouteProps {
  /** The session the File Browser shows. */
  sessionId: string | null;
}

/**
 * The File Browser header's route line when it shows a remote-desktop
 * session's side channel (#4193): which account on which host, over which
 * carrier — and a warning when that host is not the desktop host. Renders
 * nothing for any other session.
 */
export function RemoteDesktopBrowseRoute({ sessionId }: RemoteDesktopBrowseRouteProps) {
  const source = useRemoteDesktopBrowseStore((s) => browseSourceForSession(s.sources, sessionId));
  if (!source) return null;
  const { channel } = source;
  return (
    <div
      className={`rd-browse-route${channel.sameHost ? "" : " rd-browse-route--warn"}`}
      title="Remote desktop file transfer"
      data-testid="remote-desktop-browse-route"
    >
      {channel.sameHost ? (
        <MonitorUp size={14} aria-hidden />
      ) : (
        <AlertTriangle size={14} aria-hidden />
      )}
      <span>
        <code>{browseRoute(channel)}</code>
        {channel.sameHost ? " · the desktop host" : ` · ${channel.host} is not the desktop host`}
      </span>
    </div>
  );
}
