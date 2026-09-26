import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DndContext,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button, ConfirmDialog, Select, Tooltip } from "@/components/ui";
import { TransferEntryRow } from "@/components/TransferQueue";
import { useTransferControls } from "@/hooks/useTransferControls";
import { sessionSupportsTransferQueue } from "@/services/api";
import { copyBetweenPanes, type PaneCopyRequest, type PaneSide } from "@/services/paneTransfer";
import { useAppStore } from "@/store/appStore";
import { useProjectedAgents } from "@/store/useProjectedAgents";
import { useProjectedTransfers } from "@/store/useProjectedTransfers";
import type { FileEntry } from "@/types/connection";
import type { TransferViewMeta } from "@/types/terminal";
import { describeEntries, findNameConflicts } from "@/utils/fileDragMove";
import { frontendLog } from "@/utils/frontendLog";
import { transferRemoteOptions } from "@/utils/transferViewRemotes";
import { TransferPane, type PaneDragData, type PaneDropData } from "./TransferPane";
import { usePaneListing } from "./usePaneListing";
import "./TransferView.css";

/** Props for {@link TransferView}. */
export interface TransferViewProps {
  meta: TransferViewMeta;
  isVisible: boolean;
}

/** A copy waiting for the user to confirm replacing existing items. */
interface PendingCopy {
  request: PaneCopyRequest;
  conflicts: string[];
}

/** Whether `sessionId` drives the transfer queue; `false` until the probe resolves. */
function useQueueCapable(sessionId: string | null): boolean {
  const [capable, setCapable] = useState(false);
  useEffect(() => {
    setCapable(false);
    if (!sessionId) return;
    let cancelled = false;
    sessionSupportsTransferQueue(sessionId)
      .then((supported) => {
        if (!cancelled) setCapable(supported);
      })
      .catch(() => {
        if (!cancelled) setCapable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);
  return capable;
}

/**
 * The dual-pane local ↔ remote transfer view (PROD-007, #3558). The local disk
 * on the left, one remote session on the right; copy between them with the
 * arrow buttons, F5 in a focused list, or by dragging rows onto the other pane.
 * Copies run through the transfer queue (progress, pause, cancel, retry shown
 * below the panes) and refresh the destination when they finish.
 */
export function TransferView({ meta, isVisible }: TransferViewProps) {
  const tabContent = useAppStore((s) => s.tabContent);
  const connectionTypes = useAppStore((s) => s.connectionTypes);
  const removeTransfer = useAppStore((s) => s.removeTransfer);
  const { remoteAgents } = useProjectedAgents();
  const { queue } = useProjectedTransfers();
  const { handlePause, handleResume, handleCancel, handleRetry } = useTransferControls();

  const options = useMemo(
    () => transferRemoteOptions(Object.values(tabContent), connectionTypes, remoteAgents),
    [tabContent, connectionTypes, remoteAgents]
  );
  const [remoteTabId, setRemoteTabId] = useState<string | null>(meta.remoteTabId);
  const remote = options.find((o) => o.tabId === remoteTabId) ?? null;
  const sessionId = remote?.sessionId ?? null;
  const queueCapable = useQueueCapable(sessionId);

  const local = usePaneListing("local", null, meta.localPath);
  const remoteListing = usePaneListing("remote", sessionId, meta.remotePath);
  const [localSelected, setLocalSelected] = useState<Set<string>>(new Set());
  const [remoteSelected, setRemoteSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<PendingCopy | null>(null);
  const [running, setRunning] = useState(0);

  const run = useCallback(
    async (request: PaneCopyRequest) => {
      const dest = request.from === "local" ? remoteListing : local;
      setRunning((n) => n + 1);
      try {
        await copyBetweenPanes(request);
      } finally {
        setRunning((n) => n - 1);
        void dest.refresh();
      }
    },
    [local, remoteListing]
  );

  const requestCopy = useCallback(
    (from: PaneSide, entries: FileEntry[]) => {
      if (!sessionId || entries.length === 0) return;
      const dest = from === "local" ? remoteListing : local;
      if (!dest.path) return;
      const request: PaneCopyRequest = {
        from,
        entries,
        destDir: dest.path,
        remote: { sessionId, queueCapable },
      };
      frontendLog(
        "transfer_view",
        `copy ${describeEntries(entries)} ${from} → ${dest.path} (queue: ${queueCapable})`
      );
      const conflicts = findNameConflicts(
        entries,
        dest.entries.map((e) => e.name)
      );
      if (conflicts.length > 0) {
        setPending({ request, conflicts });
        return;
      }
      void run(request);
    },
    [sessionId, queueCapable, local, remoteListing, run]
  );

  const selectionOf = (side: PaneSide): FileEntry[] => {
    const listing = side === "local" ? local : remoteListing;
    const selected = side === "local" ? localSelected : remoteSelected;
    return listing.entries.filter((e) => selected.has(e.path));
  };

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const drag = event.active.data.current as PaneDragData | undefined;
      const drop = event.over?.data.current as PaneDropData | undefined;
      if (!drag || !drop || drag.side === drop.side) return;
      requestCopy(drag.side, drag.entries);
    },
    [requestCopy]
  );

  const connected = sessionId !== null;
  const transfers = sessionId ? Object.values(queue).filter((t) => t.sessionId === sessionId) : [];
  const localToRemote = selectionOf("local");
  const remoteToLocal = selectionOf("remote");

  const remotePicker = (
    <Select
      value={remote ? remote.tabId : undefined}
      onChange={setRemoteTabId}
      options={options.map((o) => ({ value: o.tabId, label: o.title }))}
      placeholder={options.length > 0 ? "Choose a connection" : "No remote connection open"}
      disabled={options.length === 0}
      aria-label="Remote connection"
      data-testid="transfer-view-remote-picker"
    />
  );

  return (
    <div
      className="transfer-view"
      hidden={!isVisible}
      aria-busy={running > 0}
      data-testid="transfer-view"
    >
      <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragEnd={handleDragEnd}>
        <div className="transfer-view__panes">
          <TransferPane
            side="local"
            title="Local"
            listing={local}
            selected={localSelected}
            onSelectedChange={setLocalSelected}
            onCopy={(entries) => requestCopy("local", entries)}
            canCopy={connected}
          />
          <div className="transfer-view__actions" role="group" aria-label="Copy between panes">
            <Tooltip content="Copy selection to the remote pane (F5)" side="top">
              <Button
                variant="secondary"
                size="sm"
                icon={<ArrowRight size={14} />}
                aria-label="Copy selected local items to the remote folder"
                aria-keyshortcuts="F5"
                disabled={!connected || localToRemote.length === 0}
                onClick={() => requestCopy("local", localToRemote)}
                data-testid="transfer-view-copy-to-remote"
              />
            </Tooltip>
            <Tooltip content="Copy selection to the local pane (F5)" side="top">
              <Button
                variant="secondary"
                size="sm"
                icon={<ArrowLeft size={14} />}
                aria-label="Copy selected remote items to the local folder"
                aria-keyshortcuts="F5"
                disabled={!connected || remoteToLocal.length === 0}
                onClick={() => requestCopy("remote", remoteToLocal)}
                data-testid="transfer-view-copy-to-local"
              />
            </Tooltip>
          </div>
          <TransferPane
            side="remote"
            title={remote?.title ?? "Remote"}
            listing={remoteListing}
            selected={remoteSelected}
            onSelectedChange={setRemoteSelected}
            onCopy={(entries) => requestCopy("remote", entries)}
            canCopy={connected}
            headerControls={remotePicker}
            placeholder={
              connected ? undefined : (
                <span data-testid="transfer-view-no-remote">
                  {options.length > 0
                    ? "Choose a remote connection to browse."
                    : "Open an SSH, SFTP, FTP, Docker or agent connection to browse it here."}
                </span>
              )
            }
          />
        </div>
      </DndContext>
      {transfers.length > 0 && (
        <div className="transfer-view__transfers" data-testid="transfer-view-transfers">
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
      <ConfirmDialog
        open={pending !== null}
        variant="warn"
        title="Replace existing items?"
        message={
          pending
            ? `${pending.conflicts.join(", ")} already exist${
                pending.conflicts.length === 1 ? "s" : ""
              } in ${pending.request.destDir}. Copying replaces ${
                pending.conflicts.length === 1 ? "it" : "them"
              }.`
            : null
        }
        confirmLabel="Replace"
        onConfirm={() => {
          const request = pending?.request;
          setPending(null);
          if (request) void run(request);
        }}
        onCancel={() => setPending(null)}
        testIdBase="transfer-view-replace"
      />
    </div>
  );
}
