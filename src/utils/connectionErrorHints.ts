/**
 * Structured, per-backend mapping from a connection-failure *situation* to the
 * user-facing hint shown on the terminal connection overlay.
 *
 * ## Why this exists (#2088)
 *
 * User-facing hints used to be ad-hoc strings inlined at the render site, which
 * let a hint written for one backend surface on an unrelated one. The reported
 * case: an **SSH** connect timeout showed *"Check that the host is reachable and
 * the agent binary is installed."* — an **agent**-connection hint that is wrong
 * on the SSH path (and, in fact, wrong on *every* path: a timeout means the
 * connection was never established, so the remote agent binary — which only
 * matters *after* the transport connects — cannot be the cause).
 *
 * Routing hints through this table gives a single reviewable place where each
 * hint is visibly tied to the backend family and situation that raises it, so a
 * hint can no longer be silently attached to the wrong backend. New backends or
 * situations extend the table rather than adding another inline string.
 *
 * ## Structured selection (I18N-009)
 *
 * The hint is chosen from `(backend family, error kind)` only. The kind comes
 * from the backend's locale-independent error code — never from matching the
 * human message, which is English today and OS-localized for serial errors —
 * and the copy is resolved through the i18n catalog (`@/i18n/catalog`).
 */

import { t, type MessageId } from "@/i18n/catalog";
import type { IpcErrorCode } from "@/types/generated/IpcErrorCode";
import type { Platform } from "@/utils/platform";
import { sshAgentStartCommand } from "@/utils/sshAgentSetup";

/**
 * Backend families we tailor connection-failure guidance for. Derived from a
 * tab's effective `sessionType` (the inner session type for remote/agent-hosted
 * tabs, the connection type for direct ones). `unknown` is the safe default —
 * its guidance is correct for any backend and never names a backend-specific
 * component.
 */
export type BackendFamily = "ssh" | "telnet" | "serial" | "docker" | "local" | "unknown";

/**
 * The typed category of a connection failure, derived **only** from the
 * backend's locale-independent error code (I18N-009) — never from the human
 * message text, which is English today and OS-localized for serial errors.
 * `other` is every failure without a curated category.
 */
export type ConnectionErrorKind =
  | "auth"
  | "agent-auth"
  | "timeout"
  | "not-found"
  | "permission"
  | "busy"
  | "other";

/**
 * Backend error codes (the ts-rs-generated {@link IpcErrorCode} slugs carried
 * on the IPC envelope) that name a connection-failure kind.
 */
const CODE_TO_KIND: Partial<Record<IpcErrorCode, Exclude<ConnectionErrorKind, "other">>> = {
  auth_failed: "auth",
  agent_auth_failed: "agent-auth",
  timeout: "timeout",
  not_found: "not-found",
  permission_denied: "permission",
  busy: "busy",
};

/**
 * Map a backend error code (as returned by `parseBackendError(err).code`) to
 * its {@link ConnectionErrorKind}. An absent or unrecognised code is `other`.
 */
export function connectionErrorKindFromCode(code: string | undefined): ConnectionErrorKind {
  if (!code) return "other";
  return CODE_TO_KIND[code as IpcErrorCode] ?? "other";
}

/**
 * Map a tab's effective `sessionType` string to a {@link BackendFamily}.
 * Anything unrecognised (including the empty string used for agent-transport
 * tabs with no inner session type) maps to `unknown`, which yields a generic,
 * always-correct reachability hint.
 */
export function backendFamilyFromSessionType(sessionType: string): BackendFamily {
  switch (sessionType) {
    case "ssh":
      return "ssh";
    case "telnet":
      return "telnet";
    case "serial":
      return "serial";
    case "docker":
      return "docker";
    case "local":
      return "local";
    default:
      return "unknown";
  }
}

/**
 * Per-backend timeout guidance. Every entry describes reachability/handshake
 * causes appropriate to that backend and deliberately never mentions the remote
 * agent binary — a timeout means the transport never connected, so the agent
 * binary cannot be the cause (#2088).
 */
const TIMEOUT_HINTS: Record<BackendFamily, MessageId> = {
  ssh: "connection.hint.timeout.ssh",
  telnet: "connection.hint.timeout.telnet",
  serial: "connection.hint.timeout.serial",
  docker: "connection.hint.timeout.docker",
  local: "connection.hint.timeout.local",
  unknown: "connection.hint.timeout.unknown",
};

/** The Linux fix for a serial permission error: join the dialout group. */
const SERIAL_DIALOUT_COMMAND = "sudo usermod -aG dialout $USER";

/** A resolved, user-facing hint for a connection failure. */
export interface ConnectionErrorHint {
  /** Optional heading for a hint rendered as a panel. */
  title?: string;
  /** The guidance text. */
  text: string;
  /** Optional fix command, rendered with a copy affordance (#1829). */
  command?: string;
}

/**
 * Resolve the hint for a failure `kind` on a backend `family`, or `null` when
 * no curated hint applies. The selection is a pure function of
 * `(family, kind)` (plus the host platform for remediation commands that only
 * exist on one OS); all copy comes from the i18n catalog.
 */
export function connectionErrorHint(
  family: BackendFamily,
  kind: ConnectionErrorKind,
  platform: Platform = "linux"
): ConnectionErrorHint | null {
  switch (kind) {
    case "timeout":
      return { text: t(TIMEOUT_HINTS[family]) };
    case "auth":
      // Credentials only exist on the remote-login backends.
      return family === "ssh" || family === "telnet" || family === "unknown"
        ? { text: t("connection.hint.auth.remote") }
        : null;
    case "agent-auth":
      // The ssh-agent remedy is SSH-specific; never leak it onto telnet/serial
      // (#2088).
      return family === "ssh"
        ? {
            title: t("connection.hint.agentAuth.title"),
            text: t("connection.hint.agentAuth.ssh"),
            command: sshAgentStartCommand(platform),
          }
        : null;
    case "not-found":
      return family === "serial" ? { text: t("connection.hint.notFound.serial") } : null;
    case "permission":
      if (family !== "serial") return null;
      // Only Linux has the dialout group, so only Linux gets the usermod fix
      // (#1831).
      return platform === "linux"
        ? {
            title: t("connection.hint.permission.title"),
            text: t("connection.hint.permission.serial.linux"),
            command: SERIAL_DIALOUT_COMMAND,
          }
        : {
            title: t("connection.hint.permission.title"),
            text: t(
              platform === "windows"
                ? "connection.hint.permission.serial.windows"
                : "connection.hint.permission.serial.macos"
            ),
          };
    case "busy":
      return family === "serial" ? { text: t("connection.hint.busy.serial") } : null;
    case "other":
      return null;
  }
}
