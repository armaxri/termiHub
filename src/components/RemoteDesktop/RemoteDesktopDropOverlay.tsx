import { Upload } from "lucide-react";
import { Spinner } from "@/components/ui";
import type { RemoteDesktopFilesStatus } from "@/hooks/useRemoteDesktopFiles";
import { routeVia, unavailableCopy } from "./fileTransfer";

interface RemoteDesktopDropOverlayProps {
  /** The session's file side channel. */
  files: RemoteDesktopFilesStatus;
  /** What the drop holds: one name or "N files". */
  subject: string;
  /** The folder a drop lands in (the session's choice or the default). */
  destDir: string | null;
}

/**
 * The dashed drop target shown while OS files are dragged over a graphical
 * session (#4192, concept `vnc-clipboard-file-transfer`). It names the exact
 * destination — folder, the host the bytes land on, and the carrier — before
 * anything moves; without a usable route it explains why and how to enable
 * file transfer, and the drop is ignored.
 */
export function RemoteDesktopDropOverlay({
  files,
  subject,
  destDir,
}: RemoteDesktopDropOverlayProps) {
  if (files.status === "ready") {
    const { channel } = files;
    return (
      <div className="rd-drop" data-testid="remote-desktop-drop-overlay" data-state="ready">
        <Upload className="rd-drop__icon" size={28} aria-hidden />
        <span className="rd-drop__title">Drop to upload {subject}</span>
        <span className="rd-drop__sub">
          to <code>{destDir ?? files.defaultDir}</code> on <code>{channel.host}</code>
        </span>
        <span className="rd-drop__sub" data-testid="remote-desktop-drop-route">
          {routeVia(channel)}
        </span>
        {!channel.sameHost && (
          <span className="rd-drop__sub rd-drop__sub--warn">
            {channel.host} is not the desktop host
          </span>
        )}
      </div>
    );
  }

  if (files.status === "resolving") {
    return (
      <div
        className="rd-drop rd-drop--off"
        data-testid="remote-desktop-drop-overlay"
        data-state="resolving"
      >
        <Spinner size="md" label={null} />
        <span className="rd-drop__title">Checking the file route…</span>
      </div>
    );
  }

  const copy =
    files.status === "unavailable"
      ? unavailableCopy(files.reason)
      : { title: "File transfer isn't available right now", hint: files.message };
  return (
    <div
      className="rd-drop rd-drop--off"
      data-testid="remote-desktop-drop-overlay"
      data-state={files.status === "unavailable" ? files.reason : files.status}
    >
      <Upload className="rd-drop__icon" size={28} aria-hidden />
      <span className="rd-drop__title">{copy.title}</span>
      <span className="rd-drop__sub">{copy.hint}</span>
    </div>
  );
}
