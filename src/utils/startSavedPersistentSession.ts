/**
 * Start a persistent session for a saved connection from the sidebar (#4454).
 *
 * A saved connection's schema secrets other than `password` (an inline
 * jump-host hop's password, a plugin secret) live in the credential store, not
 * in the loaded settings (#4289). They are resolved here through the same
 * unlock-and-prompt flow as a regular connect ({@link resolveFieldSecrets},
 * #4429) before the store starts the session, so a locked store or credential
 * storage "none" asks instead of connecting without them. A dismissed unlock
 * dialog or prompt starts nothing.
 */
import { toast } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { currentConnectionsView } from "@/store/connectionsBridge";
import { neededFieldSecrets, resolveFieldSecrets } from "@/utils/fieldSecrets";

export async function startSavedPersistentSession(connectionId: string): Promise<void> {
  const state = useAppStore.getState();
  const conn = currentConnectionsView().connections.find((c) => c.id === connectionId);
  if (!conn) return;
  const settings = conn.config.config as Record<string, unknown>;
  const schema = state.connectionTypes.find((t) => t.typeId === conn.config.type)?.schema;
  if (neededFieldSecrets(schema, settings).length === 0) {
    await state.startPersistentSession(connectionId);
    return;
  }
  const fieldSecrets = await resolveFieldSecrets({
    schema,
    settings,
    connectionId,
    sourceFile: conn.sourceFile ?? null,
    requestPassword: state.requestPassword,
    unattended: false,
  });
  if (fieldSecrets.status !== "resolved") {
    toast.info(fieldSecrets.reason);
    return;
  }
  await useAppStore.getState().startPersistentSession(connectionId, fieldSecrets.settings);
}
