/**
 * The secret of a VNC connection's linked SSH file route (#4194, #4265).
 *
 * A direct VNC connection can move files over a saved SSH connection it
 * links. When that connection's password or key passphrase is not saved (or
 * the credential store is locked), the backend's file-channel answer carries
 * a {@link LinkedSecretRequest} instead of failing outright. This helper turns
 * that request into the same interaction a normal SSH connect has: the unlock
 * dialog for a locked store, else the usual password prompt — with its "Save
 * password" box writing to the linked connection's own credential entry.
 *
 * Callers invoke it only on a user action (opening the Files popover, a drop,
 * Retry), never when a session starts; unattended paths never call it. The
 * secret is never logged.
 */
import { storeCredential } from "@/services/api";
import { currentConnectionsView } from "@/store/connectionsBridge";
import type { LinkedSecretRequest } from "@/types/generated/LinkedSecretRequest";
import type { RequestPassword } from "@/utils/graphicalSecret";
import { ensureCredentialStoreUnlocked } from "@/utils/ensureCredentialStoreUnlocked";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";

/** Outcome of {@link askLinkedSshSecret}. */
export type LinkedSecretOutcome =
  /** The store was unlocked: resolve again, the saved secret may now be read. */
  | { status: "unlocked" }
  /** The user entered the secret: hand it to `remote_desktop_file_channel`. */
  | { status: "entered"; secret: string }
  /** The user dismissed the unlock dialog or the prompt. */
  | { status: "canceled" };

/**
 * Ask the user for what `request` needs (see the module docs). A locked store
 * is unlocked first; a rejected secret is asked for again with the reason.
 */
export async function askLinkedSshSecret(
  request: LinkedSecretRequest,
  requestPassword: RequestPassword,
  signal?: AbortSignal
): Promise<LinkedSecretOutcome> {
  if (request.storeLocked && !request.rejected) {
    const unlocked = await ensureCredentialStoreUnlocked({
      authMethod: request.authMethod,
      savePassword: true,
    });
    return unlocked ? { status: "unlocked" } : { status: "canceled" };
  }

  const notice = request.rejected
    ? request.kind === "key_passphrase"
      ? "Passphrase was rejected — please re-enter."
      : "Password was rejected — please re-enter."
    : "";
  // A shared named credential (#3557) is rotated in Settings, never replaced
  // by a per-connection secret, so its prompt offers no Save box.
  // `signal` drops a queued prompt when its tab closes (#4312); the promise
  // then rejects with an AbortError.
  // The linked connection's name titles the prompt, so a queued prompt says
  // which connection it is for (#4475).
  const label = currentConnectionsView().connections.find(
    (c) => c.id === request.connectionId
  )?.name;
  const options = {
    ...(request.canSave ? {} : { allowSave: false }),
    ...(label ? { label } : {}),
    ...(signal ? { signal } : {}),
  };
  const answer =
    Object.keys(options).length === 0
      ? await requestPassword(request.host, request.username, notice, request.kind)
      : await requestPassword(request.host, request.username, notice, request.kind, options);
  if (answer === null) return { status: "canceled" };
  const entered = answer.password;

  if (request.canSave && answer.shouldSave) {
    await storeCredential(request.connectionId, request.kind, entered, request.sourceFile).catch(
      (err) =>
        frontendLog(
          "remote_desktop_files",
          `Failed to store the linked SSH ${request.kind}: ${errorMessage(err)}`
        )
    );
  }
  return { status: "entered", secret: entered };
}
