/**
 * The connection editor's view of a saved connection's stored field secrets
 * (#4431): which schema secrets other than `password` — and which inline
 * jump-host hop passwords — are kept in the credential store, by name only,
 * plus the ones the user marked for removal.
 *
 * Only names ever reach the frontend, never values. While the store cannot be
 * read (locked, unavailable, or storage mode "none") nothing is shown rather
 * than guessed; the names are fetched again once the store unlocks. A pending
 * clear is applied by {@link StoredFieldSecrets.applyPendingClears}, which the
 * editor calls on Save — an empty field on its own still keeps the secret.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { StoredSecretsControl } from "@/components/DynamicForm/storedSecrets";
import { clearFieldSecrets, listStoredFieldSecretKeys } from "@/services/api";
import type { StoredFieldSecretKeys } from "@/services/api";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";

export interface UseStoredFieldSecretsOptions {
  /** The saved connection's id, or `undefined` for a new (unsaved) one. */
  connectionId: string | undefined;
  /** The saved connection's external file (#3591), else `null`. */
  sourceFile: string | null;
  /** The credential store's storage mode (`undefined` while unknown). */
  storeMode: string | undefined;
  /** The credential store's lock status (`undefined` while unknown). */
  storeStatus: string | undefined;
}

export interface StoredFieldSecrets {
  /** Top-level secret fields, by settings key (`undefined` = show nothing). */
  fields: StoredSecretsControl | undefined;
  /** Inline-hop passwords, by hop identity (`undefined` = show nothing). */
  hops: StoredSecretsControl | undefined;
  /** Whether the user marked any stored secret for removal. */
  hasPendingClears: boolean;
  /**
   * Remove the secrets marked for removal from the credential store. Call on
   * Save, before persisting the connection; rejects when the store refuses.
   */
  applyPendingClears: () => Promise<void>;
}

const NOTHING: StoredFieldSecretKeys = { fields: [], hops: [] };

function without(list: readonly string[], name: string): string[] {
  return list.filter((n) => n !== name);
}

function withName(list: readonly string[], name: string): string[] {
  return list.includes(name) ? [...list] : [...list, name];
}

export function useStoredFieldSecrets({
  connectionId,
  sourceFile,
  storeMode,
  storeStatus,
}: UseStoredFieldSecretsOptions): StoredFieldSecrets {
  const [stored, setStored] = useState<StoredFieldSecretKeys | null>(null);
  const [cleared, setCleared] = useState<StoredFieldSecretKeys>(NOTHING);

  const readable = !!connectionId && storeMode !== undefined && storeMode !== "none";
  useEffect(() => {
    if (!readable || !connectionId) {
      setStored(null);
      return;
    }
    let cancelled = false;
    listStoredFieldSecretKeys(connectionId, sourceFile)
      .then((keys) => {
        if (!cancelled) setStored(keys);
      })
      .catch((err: unknown) => {
        frontendLog(
          "connection_editor",
          `Stored field secret names unavailable: ${errorMessage(err)}`
        );
        if (!cancelled) setStored(null);
      });
    return () => {
      cancelled = true;
    };
    // `storeStatus` re-reads the names after an unlock (or hides them after a lock).
  }, [readable, connectionId, sourceFile, storeStatus]);

  const control = useCallback(
    (kind: keyof StoredFieldSecretKeys): StoredSecretsControl | undefined => {
      if (!stored || stored[kind].length === 0) return undefined;
      return {
        stored: stored[kind],
        cleared: cleared[kind],
        onClear: (name) => setCleared((c) => ({ ...c, [kind]: withName(c[kind], name) })),
        onUndo: (name) => setCleared((c) => ({ ...c, [kind]: without(c[kind], name) })),
      };
    },
    [stored, cleared]
  );
  const fields = useMemo(() => control("fields"), [control]);
  const hops = useMemo(() => control("hops"), [control]);

  const hasPendingClears = cleared.fields.length > 0 || cleared.hops.length > 0;

  const applyPendingClears = useCallback(async () => {
    if (!connectionId || !hasPendingClears) return;
    await clearFieldSecrets(connectionId, cleared, sourceFile);
    setStored((s) =>
      s
        ? {
            fields: s.fields.filter((n) => !cleared.fields.includes(n)),
            hops: s.hops.filter((n) => !cleared.hops.includes(n)),
          }
        : s
    );
    setCleared(NOTHING);
  }, [connectionId, hasPendingClears, cleared, sourceFile]);

  return { fields, hops, hasPendingClears, applyPendingClears };
}
