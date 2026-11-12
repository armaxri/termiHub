import { useCallback, useMemo, type ReactNode } from "react";
import { useAppStore } from "@/store/appStore";
import { activeTreeTabs } from "@/store/layoutSelectors";
import { CredentialReentry } from "@/components/Terminal/CredentialReentry";
import type { ConnectionErrorKind } from "@/utils/connectionErrorHints";
import { closeTabById, editConnectionForFailure } from "@/utils/connectFailureActions";
import { passwordReentryTarget, reconnectGraphicalWithPassword } from "@/utils/passwordReentry";
import type { CredentialReentryInput, CredentialReentryTarget } from "@/utils/credentialReentry";

/** The failure-screen wiring a remote-desktop overlay needs (#5377). */
export interface RemoteDesktopFailureActions {
  onCloseTab: () => void;
  /** Present only for a tab opened from a saved connection. */
  onEditConnection?: () => void;
  /** Inline password re-entry for an auth failure. */
  credentialReentry: ReactNode;
}

/**
 * Close tab, Edit connection and credential re-entry for a remote-desktop tab's
 * failed connect — the same actions a terminal tab offers (#5377). A re-entered
 * password reconnects via `reconnect`; Save is held until that connect succeeds.
 */
export function useRemoteDesktopFailureActions(
  tabId: string,
  errorKind: ConnectionErrorKind,
  reconnect: () => void
): RemoteDesktopFailureActions {
  const config = useAppStore((s) => activeTreeTabs(s).find((t) => t.id === tabId)?.config);
  const connectionId = useAppStore(
    (s) => activeTreeTabs(s).find((t) => t.id === tabId)?.connectionId
  );
  const target = useMemo(
    () => passwordReentryTarget(config, connectionId, true),
    [config, connectionId]
  );
  const onCloseTab = useCallback(() => closeTabById(tabId), [tabId]);
  const onEdit = useCallback(() => {
    if (connectionId) editConnectionForFailure(connectionId, errorKind);
  }, [connectionId, errorKind]);
  const onSubmit = useCallback(
    (t: CredentialReentryTarget, input: CredentialReentryInput) =>
      reconnectGraphicalWithPassword(tabId, t, input, reconnect),
    [tabId, reconnect]
  );
  return {
    onCloseTab,
    onEditConnection: connectionId ? onEdit : undefined,
    credentialReentry: <CredentialReentry tabId={tabId} target={target} onSubmit={onSubmit} />,
  };
}
