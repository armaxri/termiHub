import { useState } from "react";
import {
  AlertTriangle,
  Download,
  FolderOpen,
  RefreshCw,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";
import { Button, Spinner } from "@/components/ui";
import { TransferEntryRow } from "@/components/TransferQueue";
import { useAppStore } from "@/store/appStore";
import { useProjectedTransfers } from "@/store/useProjectedTransfers";
import { useTransferControls } from "@/hooks/useTransferControls";
import type { RemoteDesktopFilesStatus } from "@/hooks/useRemoteDesktopFiles";
import { routeCarrier, unavailableCopy } from "./fileTransfer";
import { RemoteDesktopUploadFolderDialog } from "./RemoteDesktopUploadFolderDialog";

interface RemoteDesktopFilesProps {
  /** The graphical session (its transfers are listed). */
  sessionId: string;
  /** The session's file side channel. */
  files: RemoteDesktopFilesStatus;
  /** The folder uploads go to (the session's choice or the default). */
  destDir: string | null;
  /** Pick local files and upload them (into `dest` when given). */
  onUpload: (dest?: string) => Promise<void>;
  /** Re-resolve a degraded route. */
  onRetry: () => void;
  onClose: () => void;
}

/** The route line or the reason there is none, per channel state. */
function RouteStatus({
  files,
  destDir,
  onRetry,
}: Pick<RemoteDesktopFilesProps, "files" | "destDir" | "onRetry">) {
  if (files.status === "resolving") {
    return (
      <div className="rd-files__route" data-testid="remote-desktop-files-route">
        <Spinner size="sm" label={null} />
        <span>Checking the file route…</span>
      </div>
    );
  }
  if (files.status === "ready") {
    const { channel } = files;
    return (
      <div className="rd-files__route" data-testid="remote-desktop-files-route">
        <ShieldCheck size={14} aria-hidden />
        <span>
          <code>{destDir ?? files.defaultDir}</code> on <code>{channel.host}</code> ·{" "}
          {routeCarrier(channel)}
          {!channel.sameHost && ` — ${channel.host} is not the desktop host`}
        </span>
      </div>
    );
  }
  if (files.status === "unavailable") {
    const copy = unavailableCopy(files.reason);
    return (
      <div className="rd-files__route" data-testid="remote-desktop-files-route">
        <span>
          <strong>{copy.title}.</strong> {copy.hint}
        </span>
      </div>
    );
  }
  return (
    <div className="rd-files__route rd-files__route--warn" data-testid="remote-desktop-files-route">
      <AlertTriangle size={14} aria-hidden />
      <span>{files.message}</span>
      <Button
        variant="ghost"
        size="xs"
        icon={<RefreshCw size={12} />}
        onClick={onRetry}
        data-testid="remote-desktop-files-retry"
      >
        Retry
      </Button>
    </div>
  );
}

/**
 * The toolbar's Files popover (#4192, concept `vnc-clipboard-file-transfer`):
 * the route line (folder · file host · carrier — the trust statement),
 * **Upload files…**, **Upload to folder…**, **Browse remote files** (arrives
 * with remote browsing, #4193) and this session's transfers, mirrored from the
 * Transfers queue with the same rows and controls.
 */
export function RemoteDesktopFiles({
  sessionId,
  files,
  destDir,
  onUpload,
  onRetry,
  onClose,
}: RemoteDesktopFilesProps) {
  const [folderOpen, setFolderOpen] = useState(false);
  const { queue } = useProjectedTransfers();
  const { handlePause, handleResume, handleCancel, handleRetry } = useTransferControls();
  const removeTransfer = useAppStore((s) => s.removeTransfer);
  const transfers = Object.values(queue).filter((t) => t.sessionId === sessionId);
  const ready = files.status === "ready";

  return (
    <div
      className="rd-files"
      role="dialog"
      aria-label="Files"
      data-testid="remote-desktop-files"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="rd-files__header">
        <span>Files</span>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon={<X size={14} />}
          title="Close"
          onClick={onClose}
          data-testid="remote-desktop-files-close"
        />
      </div>
      <RouteStatus files={files} destDir={destDir} onRetry={onRetry} />
      <div className="rd-files__actions">
        <Button
          variant="ghost"
          size="sm"
          fullWidth
          icon={<Upload size={14} />}
          disabled={!ready}
          onClick={() => onUpload()}
          pendingLabel="Uploading…"
          data-testid="remote-desktop-files-upload"
        >
          <span className="rd-files__label">Upload files…</span>
          <span className="rd-files__hint">or drop on screen</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          fullWidth
          icon={<FolderOpen size={14} />}
          disabled={!ready}
          onClick={() => setFolderOpen(true)}
          data-testid="remote-desktop-files-upload-folder"
        >
          <span className="rd-files__label">Upload to folder…</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          fullWidth
          icon={<Download size={14} />}
          disabled
          title="Browsing and downloading remote files arrives in a later update"
          data-testid="remote-desktop-files-browse"
        >
          <span className="rd-files__label">Browse remote files</span>
          <span className="rd-files__hint">coming soon</span>
        </Button>
      </div>
      {transfers.length > 0 && (
        <div className="rd-files__transfers" data-testid="remote-desktop-files-transfers">
          {transfers.map((t) => (
            <TransferEntryRow
              key={t.id}
              entry={t}
              compact
              onPause={handlePause}
              onResume={handleResume}
              onCancel={handleCancel}
              onRetry={handleRetry}
              onRemove={removeTransfer}
            />
          ))}
        </div>
      )}
      {ready && (
        <RemoteDesktopUploadFolderDialog
          open={folderOpen}
          host={files.channel.host}
          defaultDir={destDir ?? files.defaultDir}
          onCancel={() => setFolderOpen(false)}
          onSubmit={(dir) => {
            setFolderOpen(false);
            void onUpload(dir);
          }}
        />
      )}
    </div>
  );
}
