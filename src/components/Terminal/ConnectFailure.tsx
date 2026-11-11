/**
 * Shared pieces of the connect-failure screen (#5183, #5377): the humanised
 * hint, the collapsed technical "Details" disclosure, and the Retry / Edit
 * connection / Close tab actions. Terminal, remote-desktop (VNC/RDP) and
 * file-browser (FTP) tabs render them inside {@link ConnectProgress} so every
 * connection type fails, aborts and retries with the same words and buttons.
 */
import { Copy, Pencil, RefreshCw, X } from "lucide-react";
import { writeText as writeClipboard } from "@tauri-apps/plugin-clipboard-manager";
import { Button } from "@/components/ui/Button";
import { toast } from "@/components/ui";
import type { ConnectProgressPhase } from "@/components/ui/ConnectProgress";
import {
  connectionErrorHeading,
  type ConnectionErrorHint,
  type ConnectionErrorKind,
} from "@/utils/connectionErrorHints";
import { t } from "@/i18n/catalog";
import "./TerminalConnectionOverlay.css";

/**
 * Copy a suggested fix command to the clipboard so the user can paste and run it
 * instead of retyping it by hand (#1829). Returns the promise so the Button drives
 * its success flash; a rejection surfaces via the Button's error toast.
 */
async function copyCommand(command: string): Promise<void> {
  await writeClipboard(command);
  toast.success("Command copied to clipboard");
}

/** Copy the raw backend error so it can be pasted into a bug report (#5183). */
async function copyError(error: string): Promise<void> {
  await writeClipboard(error);
  toast.success(t("connection.details.copied"));
}

/**
 * The technical backend error of a network failure, kept available but
 * secondary to the plain-language hint (#5183): a collapsed "Details"
 * disclosure with a copy action.
 */
export function ConnectErrorDetails({ error }: { error: string }) {
  return (
    <details
      className="terminal-connection-overlay__details"
      data-testid="terminal-connection-error-details"
    >
      <summary>{t("connection.details.show")}</summary>
      <div className="terminal-connection-overlay__command-row">
        <code className="terminal-connection-overlay__hint-code">{error}</code>
        <Button
          variant="ghost"
          iconOnly
          size="sm"
          icon={<Copy size={14} aria-hidden />}
          aria-label={t("connection.details.copy")}
          title={t("connection.details.copy")}
          data-testid="terminal-connection-error-copy-btn"
          onClick={() => copyError(error)}
        />
      </div>
    </details>
  );
}

/**
 * A suggested shell command shown on the failure screen, with a copy affordance
 * (#1829): the command text is selectable, and a ghost icon button copies it to
 * the clipboard with a success toast. Reuses the pattern established for the
 * X-server setup dialog (#1819).
 */
function CommandBlock({ command, testId }: { command: string; testId?: string }) {
  return (
    <div className="terminal-connection-overlay__command-row">
      <code className="terminal-connection-overlay__hint-code">{command}</code>
      <Button
        variant="ghost"
        iconOnly
        size="sm"
        icon={<Copy size={14} aria-hidden />}
        aria-label="Copy command"
        title="Copy command"
        data-testid={testId}
        onClick={() => copyCommand(command)}
      />
    </div>
  );
}

/** The plain-language hint for a failure (a panel when it has a title or command). */
export function ConnectFailureHint({
  hint,
  copyTestId,
}: {
  hint: ConnectionErrorHint | null;
  copyTestId?: string;
}) {
  if (!hint) return null;
  if (hint.title || hint.command) {
    return (
      <div className="terminal-connection-overlay__hint">
        {hint.title && <p className="terminal-connection-overlay__hint-title">{hint.title}</p>}
        <p>{hint.text}</p>
        {hint.command && <CommandBlock command={hint.command} testId={copyTestId} />}
      </div>
    );
  }
  return <p className="terminal-connection-overlay__hint-text">{hint.text}</p>;
}

/** The resting phase of a connect that ended: aborted, timed out, or failed. */
export function restingConnectPhase(
  aborted: boolean,
  kind: ConnectionErrorKind
): Extract<ConnectProgressPhase, "failed" | "timeout" | "aborted"> {
  if (aborted) return "aborted";
  return kind === "timeout" ? "timeout" : "failed";
}

/**
 * The heading of a resting connect screen — the same words as the
 * {@link ConnectProgress} defaults, with a refused / unreachable / unresolvable
 * host naming itself (#5183).
 */
export function restingConnectHeading(
  phase: Extract<ConnectProgressPhase, "failed" | "timeout" | "aborted">,
  kind: ConnectionErrorKind
): string {
  switch (phase) {
    case "aborted":
      return "Connection aborted";
    case "timeout":
      return "Timed out";
    case "failed":
      return connectionErrorHeading(kind) ?? "Connection failed";
  }
}

/** Props for {@link ConnectFailureActions}. */
export interface ConnectFailureActionsProps {
  /** Start a fresh connect attempt. */
  onRetry: () => void;
  /** Open the saved connection's editor; omitted hides the action. */
  onEdit?: () => void;
  /** Close the tab. */
  onClose: () => void;
  /** Test ids of the three buttons. */
  testIds: { retry: string; edit: string; close: string };
}

/**
 * The resting-screen actions, worded and styled exactly like a terminal tab's
 * (#5377): **Retry** (primary), **Edit connection** for a saved connection,
 * and **Close tab**.
 */
export function ConnectFailureActions({
  onRetry,
  onEdit,
  onClose,
  testIds,
}: ConnectFailureActionsProps) {
  return (
    <>
      <Button
        size="sm"
        variant="primary"
        icon={<RefreshCw size={14} />}
        onClick={onRetry}
        data-testid={testIds.retry}
      >
        Retry
      </Button>
      {onEdit && (
        <Button
          size="sm"
          variant="secondary"
          icon={<Pencil size={14} />}
          onClick={onEdit}
          data-testid={testIds.edit}
        >
          {t("connection.action.edit")}
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        icon={<X size={14} />}
        onClick={onClose}
        data-testid={testIds.close}
      >
        Close tab
      </Button>
    </>
  );
}
