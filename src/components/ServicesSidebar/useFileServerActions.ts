import { useCallback, useState } from "react";
import { toast } from "@/components/ui";
import { useDeleteConfirm } from "@/hooks/useDeleteConfirm";
import type { ServiceLifecycleConfirm } from "@/hooks/useServiceLifecycleConfirm";
import {
  persistUndoableDeleteOptOut,
  useUndoableDeleteOptOut,
} from "@/hooks/useUndoableDeleteOptOut";
import { t, tf } from "@/i18n/catalog";
import { newId } from "@/services/transport/ids";
import { useAppStore } from "@/store/appStore";
import type { EmbeddedServerConfig, ServerType } from "@/types/embeddedServer";
import { errorMessage } from "@/utils/errorMessage";
import { hostChoice, sameHost, type HostChoice } from "@/utils/hostChoice";
import { serviceDeleteEffect } from "@/utils/serviceDelete";
import type { ServiceModel } from "@/utils/serviceModel";
import { isServiceActive, serverServiceState } from "@/utils/serviceState";

/** Whether `config` signs clients in with a password (kept in the credential store). */
function hasPassword(config: EmbeddedServerConfig): boolean {
  return !!config.httpAuth || config.ftpAuth?.type === "credentials";
}

/** What the dialog edits. */
interface Editing {
  config: EmbeddedServerConfig | null;
  /** A copy that has to be given its password before it is saved (#6028, F-4). */
  draft: EmbeddedServerConfig | null;
  initialType: ServerType;
}

const NOTHING: Editing = { config: null, draft: null, initialType: "http" };

type ModelOf = (id: string) => Pick<ServiceModel, "name" | "counters">;

/** What the rows of the file servers do, and their dialogs. */
export function useFileServerActions(
  modelOf: ModelOf,
  requestLifecycle: ServiceLifecycleConfirm["request"]
) {
  const servers = useAppStore((s) => s.embeddedServers);
  const states = useAppStore((s) => s.embeddedServerStates);
  const saveEmbeddedServer = useAppStore((s) => s.saveEmbeddedServer);
  const deleteEmbeddedServer = useAppStore((s) => s.deleteEmbeddedServer);
  const start = useAppStore((s) => s.startEmbeddedServer);
  const stopEmbeddedServer = useAppStore((s) => s.stopEmbeddedServer);
  const restartEmbeddedServer = useAppStore((s) => s.restartEmbeddedServer);
  const [dialogOpen, setOpen] = useState(false);
  const [editing, setEditing] = useState<Editing>(NOTHING);

  const show = useCallback((next: Partial<Editing>) => {
    setEditing({ ...NOTHING, ...next });
    setOpen(true);
  }, []);

  const create = useCallback((initialType: ServerType) => show({ initialType }), [show]);

  const edit = useCallback(
    (id: string) => {
      const config = servers.find((server) => server.id === id);
      if (config) show({ config });
    },
    [servers, show]
  );

  /**
   * Persist a server from the dialog. Resolves `true` when the save succeeded
   * (so the dialog closes) and `false` on failure (dialog stays open to retry).
   *
   * The host goes along only when the user chose another machine (#6028): the
   * backend keeps the stored one otherwise, so a list that is out of date in
   * this window cannot move the server.
   */
  const save = useCallback(
    async (config: EmbeddedServerConfig, location: HostChoice): Promise<boolean> => {
      const isNew = !config.id;
      const { host: stored, ...rest } = config;
      const moved = location.kind !== "unreadable" && !sameHost(hostChoice(stored), location);
      const saved: EmbeddedServerConfig = {
        ...rest,
        ...(isNew ? { id: newId("srv") } : {}),
        ...(location.kind !== "unreadable" && (isNew || moved) ? { host: location } : {}),
      };
      try {
        await saveEmbeddedServer(saved);
        return true;
      } catch (err) {
        toast.error(`Failed to save "${saved.name}"`, { description: errorMessage(err) });
        return false;
      }
    },
    [saveEmbeddedServer]
  );

  const duplicate = useCallback(
    async (id: string) => {
      const original = servers.find((server) => server.id === id);
      if (!original) return;
      const copy: EmbeddedServerConfig = {
        ...original,
        id: newId("srv"),
        name: `Copy of ${original.name}`,
        autoStart: false,
      };
      // The password stays with the original, so a copy that needs one opens in
      // the editor instead of being saved in a state that cannot start.
      if (hasPassword(original)) {
        show({ draft: { ...copy, id: "" } });
        return;
      }
      try {
        await saveEmbeddedServer(copy);
      } catch (err) {
        toast.error(`Failed to duplicate "${original.name}"`, { description: errorMessage(err) });
      }
    },
    [servers, saveEmbeddedServer, show]
  );

  // "Use 8081" beside "Port 8080 is already in use" (#6063).
  const usePort = useCallback(
    async (id: string, port: number) => {
      const server = servers.find((item) => item.id === id);
      if (!server) return;
      // Without the host: the backend keeps the stored one.
      const { host: _stored, ...rest } = server;
      await saveEmbeddedServer({ ...rest, port });
      await start(id);
    },
    [servers, saveEmbeddedServer, start]
  );

  const stop = useCallback(
    (id: string) => requestLifecycle("stop", modelOf(id), () => stopEmbeddedServer(id)),
    [requestLifecycle, modelOf, stopEmbeddedServer]
  );
  const restart = useCallback(
    (id: string) => requestLifecycle("restart", modelOf(id), () => restartEmbeddedServer(id)),
    [requestLifecycle, modelOf, restartEmbeddedServer]
  );

  // Delete is destructive (and stops a running server), so it asks first (#1393).
  // Like a tunnel (#6076): it can be undone, so one that holds nothing open may be
  // deleted without asking.
  const optOut = useUndoableDeleteOptOut();
  const { take: takeOptOut, reset: resetOptOut, shouldConfirm } = optOut;
  const deleteNow = useCallback(
    async (id: string) => {
      const name = servers.find((server) => server.id === id)?.name ?? "";
      try {
        await deleteEmbeddedServer(id);
      } catch (err) {
        toast.error(`Failed to delete "${name}"`, { description: errorMessage(err) });
      }
    },
    [servers, deleteEmbeddedServer]
  );
  const stateOf = useCallback((id: string) => serverServiceState(states[id]?.status), [states]);
  const deletion = useDeleteConfirm<string>((id) => {
    if (!isServiceActive(stateOf(id)) && takeOptOut()) persistUndoableDeleteOptOut();
    return deleteNow(id);
  });
  const { request: askToDelete, cancel: cancelDelete } = deletion;
  const remove = useCallback(
    (id: string) => {
      if (isServiceActive(stateOf(id)) || shouldConfirm) askToDelete(id);
      else void deleteNow(id);
    },
    [stateOf, shouldConfirm, askToDelete, deleteNow]
  );
  const onCancelDelete = useCallback(() => {
    resetOptOut();
    cancelDelete();
  }, [resetOptOut, cancelDelete]);

  const pending = servers.find((server) => server.id === deletion.pending);
  const pendingState = pending ? stateOf(pending.id) : "stopped";
  const open = (pending && states[pending.id]?.stats.activeConnections) ?? 0;

  const stored = editing.config ?? editing.draft;
  return {
    start,
    stop,
    restart,
    create,
    edit,
    duplicate,
    usePort,
    remove,
    deleteDialogProps: {
      ...deletion.dialogProps,
      onCancel: onCancelDelete,
      title: tf("service.delete.title", { name: pending?.name ?? "" }),
      message: [
        serviceDeleteEffect(pendingState, open),
        t("service.delete.folder"),
        t("service.delete.undo"),
      ].join(" "),
      dontAskAgain: isServiceActive(pendingState) ? undefined : optOut.dontAskAgain,
    },
    editDialogProps: {
      open: dialogOpen,
      onOpenChange: setOpen,
      ...editing,
      onSave: save,
      running:
        editing.config !== null &&
        isServiceActive(serverServiceState(states[editing.config.id]?.status)),
      runLocation: hostChoice(stored?.host),
    },
  };
}
