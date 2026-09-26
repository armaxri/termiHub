import { useCallback, useEffect, useState } from "react";
import { ImageDown, ImageUp } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui";
import {
  remoteDesktopClipboardImageStatus,
  remoteDesktopCopyClipboardImage,
  remoteDesktopSendClipboardImage,
} from "@/services/api";
import type { ClipboardImageInfo, ClipboardImageStatus } from "@/types/remoteDesktop";
import { frontendLog } from "@/utils/frontendLog";

interface RemoteDesktopClipboardImageProps {
  /** The graphical session whose clipboard image this section drives. */
  sessionId: string;
  /** View-only sessions never push local data, so "Send" is hidden. */
  viewOnly: boolean;
}

/** `1920 × 1080` */
function formatDimensions(info: ClipboardImageInfo): string {
  return `${info.width} × ${info.height}`;
}

/**
 * Image section of the remote-desktop clipboard panel (PROD-021).
 *
 * Shows whether the remote copied an image (with its dimensions) and offers
 * "Copy image" (remote → local OS clipboard) and "Send local image" (local OS
 * clipboard → remote). The pixels never enter the webview — the backend moves
 * them and enforces the size caps. Hidden entirely when the protocol has no
 * image clipboard (VNC's standard clipboard is text only).
 */
export function RemoteDesktopClipboardImage({
  sessionId,
  viewOnly,
}: RemoteDesktopClipboardImageProps) {
  const [status, setStatus] = useState<ClipboardImageStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    remoteDesktopClipboardImageStatus(sessionId)
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch((err) => frontendLog("remote_desktop", `clipboard_image_info failed: ${err}`));
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const handleCopy = useCallback(async () => {
    const info = await remoteDesktopCopyClipboardImage(sessionId);
    if (info) {
      toast.success(`Image copied to clipboard (${formatDimensions(info)})`);
    } else {
      toast.info("No remote image to copy");
    }
  }, [sessionId]);

  const handleSend = useCallback(async () => {
    const info = await remoteDesktopSendClipboardImage(sessionId);
    if (info) {
      toast.success(`Image sent to remote (${formatDimensions(info)})`);
    } else {
      toast.info("No image on the local clipboard");
    }
  }, [sessionId]);

  if (!status?.supported) return null;

  return (
    <div className="rd-clipboard__image" data-testid="remote-desktop-clipboard-image">
      <span className="rd-clipboard__files-label">Image</span>
      <span className="rd-clipboard__image-meta" data-testid="remote-desktop-clipboard-image-meta">
        {status.image ? `Remote image · ${formatDimensions(status.image)}` : "No remote image"}
      </span>
      <div className="rd-clipboard__image-actions">
        {status.image && (
          <Button
            variant="secondary"
            size="sm"
            icon={<ImageDown size={14} />}
            onClick={handleCopy}
            pendingLabel="Copying…"
            data-testid="remote-desktop-clipboard-copy-image"
          >
            Copy image
          </Button>
        )}
        {!viewOnly && (
          <Button
            variant="secondary"
            size="sm"
            icon={<ImageUp size={14} />}
            onClick={handleSend}
            pendingLabel="Sending…"
            data-testid="remote-desktop-clipboard-send-image"
          >
            Send local image
          </Button>
        )}
      </div>
    </div>
  );
}
