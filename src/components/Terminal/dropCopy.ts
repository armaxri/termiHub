/**
 * Transport-specific wording for a dropped terminal session (#5619, #5660).
 *
 * A dropped session used to read the same for every connection type: the
 * reconnect strip talked about "an agent" and "the remote shell" even for an
 * unplugged serial device, and the scrollback separator was "[Process exited]"
 * although no process ended. This module picks the wording from what actually
 * dropped — a serial device, a network link (SSH / Telnet), or a session on a
 * termiHub remote agent — and keeps "[Process exited…]" for real process exits.
 */
import { t, tf } from "@/i18n/catalog";
import { RECONNECTING_HEADING } from "@/utils/reconnectStatus";
import type { SessionEndCause } from "@/types/generated/SessionEndCause";
import type { TerminalExitInfo } from "@/types/terminal";
import { serialDeviceName } from "@/utils/serialDeviceName";

/** What kind of link a dropped session ran over. */
export type DropTransport = "serial" | "ssh" | "telnet" | "agent" | "other";

/** The parts of a tab's connection identity the wording depends on. */
export interface DropIdentity {
  /** The effective session type (the inner type of an agent session). */
  sessionType: string;
  /** The session runs on a termiHub remote agent. */
  viaAgent: boolean;
}

/** Classify a tab's connection for the drop wording. Unknown tabs are `other`. */
export function dropTransportOf(identity: DropIdentity | undefined): DropTransport {
  if (!identity) return "other";
  if (identity.viaAgent) return "agent";
  switch (identity.sessionType) {
    case "serial":
      return "serial";
    case "ssh":
      return "ssh";
    case "telnet":
      return "telnet";
    default:
      return "other";
  }
}

/**
 * Why a session ended, in one word (#5831): the user disconnected it, it ended
 * normally, its process exited with a code, the server closed the link, the
 * link timed out, the network failed, the device went away, or the link was
 * lost for a reason the backend could not tell.
 */
export type DisconnectCause =
  | "user"
  | "ended"
  | "exited"
  | "server"
  | "timeout"
  | "network"
  | "device"
  | "lost";

/** Causes where the link dropped on its own (no process exit, no user action). */
const LINK_CAUSES: ReadonlySet<DisconnectCause> = new Set([
  "server",
  "timeout",
  "network",
  "device",
  "lost",
]);

/** Whether `cause` is a dropped link, the only kind auto-reconnect retries. */
export function isLinkDrop(cause: DisconnectCause | undefined): boolean {
  return cause !== undefined && LINK_CAUSES.has(cause);
}

/** What the cause line needs to know about how the session ended. */
export interface DisconnectCauseInput {
  transport: DropTransport;
  /** The classified exit, when the session has exited (it is cleared while a
   * reconnect loop runs). */
  exit?: TerminalExitInfo;
  /** The backend's verdict on why the link ended (#5696), kept through the
   * reconnect loop and its give-up. */
  endCause?: SessionEndCause | null;
}

/**
 * Classify why a session ended (#5831). A user kill and a process exit win over
 * the link's end cause; a serial transport's drop is its device going away.
 * `undefined` when nothing is known (no exit and no end cause).
 */
export function disconnectCauseOf(input: DisconnectCauseInput): DisconnectCause | undefined {
  const { transport, exit, endCause } = input;
  if (exit?.reason === "killed") return "user";
  if (exit && exit.code !== null) {
    return exit.reason === "clean" && exit.code === 0 ? "ended" : "exited";
  }
  if (exit?.reason === "clean") return "ended";
  if (!exit && !endCause) return undefined;
  if (endCause === "device_gone" || transport === "serial") return "device";
  if (endCause === "remote_closed") return "server";
  if (endCause === "timeout") return "timeout";
  if (endCause === "io_error") return "network";
  return "lost";
}

/**
 * The one cause line every disconnect notice shows (#5831): the strip, the
 * overlay and the view-mode banner all say why the session ended the same way.
 * `device` is the serial port path, when known (its short name is shown).
 */
export function disconnectCauseLine(
  cause: DisconnectCause,
  details: { code?: number | null; device?: string } = {}
): string {
  switch (cause) {
    case "user":
      return t("drop.cause.user");
    case "ended":
      return details.code === null || details.code === undefined
        ? t("drop.cause.ended")
        : tf("drop.cause.endedCode", { code: details.code });
    case "exited":
      return tf("drop.cause.exited", { code: details.code ?? "?" });
    case "server":
      return t("drop.cause.server");
    case "timeout":
      return t("drop.cause.timeout");
    case "network":
      return t("drop.cause.network");
    case "device":
      return details.device
        ? tf("drop.cause.device", { device: serialDeviceName(details.device) })
        : t("drop.cause.deviceUnknown");
    case "lost":
      return t("drop.cause.lost");
  }
}

/**
 * The strip heading while an automatic reconnect runs. The link's cause, when
 * the backend knows it, wins over the transport's default wording (#5831).
 */
export function reconnectHeadingFor(transport: DropTransport, cause?: DisconnectCause): string {
  if (cause === "device" || transport === "serial") return t("drop.heading.serial");
  if (cause === "server") return t("drop.heading.server");
  if (cause === "timeout") return t("drop.heading.timeout");
  if (transport === "telnet") return t("drop.heading.telnet");
  return RECONNECTING_HEADING;
}

/** The strip status line for a plain (non-loop) in-flight reconnect. */
export function reconnectStatusFor(transport: DropTransport): string {
  return transport === "serial" ? t("drop.status.serial") : t("drop.status.network");
}

/**
 * The strip's one detail line: what survives the drop and what the reconnect
 * brings back. `target` is the serial port path, when known.
 */
export function reconnectDetailFor(transport: DropTransport, target?: string): string {
  switch (transport) {
    case "serial":
      return target
        ? tf("drop.detail.serial", { port: target })
        : t("drop.detail.serialUnknownPort");
    case "ssh":
      return t("drop.detail.ssh");
    case "telnet":
      return t("drop.detail.telnet");
    case "agent":
      return t("drop.detail.agent");
    case "other":
      return t("drop.detail.other");
  }
}

/** Transports whose server can close the link (#5696; on an agent, #5732). */
const SERVER_TRANSPORTS: ReadonlySet<DropTransport> = new Set(["ssh", "telnet", "agent"]);

/** Local wall-clock time as `hh:mm:ss` (24-hour). */
export function formatClock(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/**
 * The line written into the scrollback when a session ends. A dropped link
 * (no exit code, on a serial / network / agent transport) reads as
 * "— connection lost hh:mm:ss —" or "— device disconnected hh:mm:ss —"; an
 * SSH / Telnet server that closed the connection cleanly reads as
 * "— connection closed by server hh:mm:ss —" (#5696) — also when that
 * server served a session on a remote agent, which the agent reports with the
 * session's end cause (#5732; a lost agent link never carries one); a serial
 * device on an agent that is gone for good (`device_gone`, #5783) reads as
 * "device disconnected" like a direct serial tab; any real
 * process exit keeps "[Process exited…]".
 */
export function sessionEndSeparator(input: {
  transport: DropTransport;
  exitCode: number | null;
  reason: "clean" | "dropped" | "killed";
  at: Date;
  /** Why the link ended, when the backend knows (#5696). */
  endCause?: SessionEndCause | null;
}): string {
  const { transport, exitCode, reason, at, endCause } = input;
  if (reason === "dropped" && exitCode === null && transport !== "other") {
    const time = formatClock(at);
    // A serial device on a remote agent that is gone for good (#5783).
    if (transport === "serial" || (transport === "agent" && endCause === "device_gone")) {
      return tf("drop.separator.serial", { time });
    }
    if (endCause === "remote_closed" && SERVER_TRANSPORTS.has(transport)) {
      return tf("drop.separator.remoteClosed", { time });
    }
    return tf("drop.separator.network", { time });
  }
  return exitCode === null ? "[Process exited]" : `[Process exited with code ${exitCode}]`;
}

/**
 * The marker written after a successful reconnect (#5660). It says what the new
 * session lost (#5831, R-101): SSH and an agent open a new remote shell (#5953),
 * telnet a new telnet session and any other session starts afresh, so running
 * programs are gone; a serial device is reopened and keeps the plain marker. A
 * local process was restarted, not reconnected (#5955): its marker says so.
 */
export function reconnectedMarker(at: Date, transport: DropTransport = "other"): string {
  const time = formatClock(at);
  if (transport === "serial") return tf("drop.separator.reconnected", { time });
  if (transport === "telnet") return tf("drop.separator.reconnectedTelnet", { time });
  if (transport === "ssh" || transport === "agent") {
    return tf("drop.separator.reconnectedShell", { time });
  }
  if (transport === "other") return tf("drop.separator.restarted", { time });
  return tf("drop.separator.reconnectedSession", { time });
}

/**
 * The marker written when an agent tab's reconnect re-attached its own,
 * still-running session (#5953): nothing was lost.
 */
export function resumedMarker(at: Date): string {
  return tf("drop.separator.resumed", { time: formatClock(at) });
}

/**
 * What kind of end a session-end notice shows (#5910), which picks its icon
 * and tone: a process that exited with a code, a session that ended normally,
 * a session the user disconnected, an unplugged device, or a dropped link.
 */
export type SessionEndKind = "exited" | "ended" | "user" | "device" | "link";

/**
 * Whether a session ended because its process did (#5955): it exited with a
 * code, or ended normally. The tab strip then shows a stop marker rather than
 * the network-drop plug.
 */
export function isProcessEnd(kind: SessionEndKind): boolean {
  return kind === "exited" || kind === "ended";
}

/** The heading, cause line and action of a session-end notice (#5910). */
export interface SessionEndNotice {
  kind: SessionEndKind;
  /** The notice heading, without a trailing stop. */
  heading: string;
  /** Why the session ended, when the heading does not already say it. */
  causeLine: string | undefined;
  /** The primary action: start the process again, or reconnect the link. */
  action: "restart" | "reconnect";
}

/**
 * The session-end notice for `cause` (#5910). A process that exits is not a
 * lost connection: it reads "Process exited (code N)" — for a local process
 * also when it ended normally with code 0 (#5955) —, a remote session's normal
 * end reads "Session ended", and only a dropped link says "Session
 * disconnected". A
 * local process (transport `other`) offers Restart; a session over a link
 * offers Reconnect, since starting it again reconnects first.
 */
export function sessionEndNoticeFor(
  cause: DisconnectCause | undefined,
  details: { transport: DropTransport; code?: number | null; device?: string }
): SessionEndNotice {
  const { transport, code, device } = details;
  const local = transport === "other";
  const line = disconnectCauseLine(cause ?? "lost", { code, device });
  // A local process that ended on its own reads one way whatever its code
  // (#5955): "Process exited (code 0)" like "Process exited (code 3)".
  if (local && (cause === "exited" || cause === "ended")) {
    return {
      kind: "exited",
      heading: processExitedHeading(code),
      causeLine: undefined,
      action: "restart",
    };
  }
  switch (cause) {
    case "exited":
      return {
        kind: "exited",
        heading: processExitedHeading(code),
        causeLine: undefined,
        action: local ? "restart" : "reconnect",
      };
    case "ended":
      return {
        kind: "ended",
        heading: t("drop.end.ended"),
        causeLine: line,
        action: local ? "restart" : "reconnect",
      };
    case "user":
      return {
        kind: "user",
        heading: t("drop.end.ended"),
        causeLine: line,
        action: local ? "restart" : "reconnect",
      };
    case "device":
      return {
        kind: "device",
        heading: t("drop.end.device"),
        causeLine: line,
        action: "reconnect",
      };
    default:
      return {
        kind: "link",
        heading: t("drop.end.disconnected"),
        causeLine: line,
        action: "reconnect",
      };
  }
}

/** "Process exited (code N)", or "Process exited" when the code is unknown. */
function processExitedHeading(code: number | null | undefined): string {
  return code === null || code === undefined
    ? t("drop.end.exitedNoCode")
    : tf("drop.end.exited", { code });
}

/** "Press Enter to reconnect." when Enter reconnects a link (#5823). */
export const ENTER_TO_RECONNECT_HINT = t("drop.end.enterReconnect");

/** "Press Enter to restart." when Enter starts a local process again (#5910). */
export const ENTER_TO_RESTART_HINT = t("drop.end.enterRestart");

/**
 * The "Press Enter to …" hint every session-end notice shows (#5955): the
 * strip and the view-mode banner say the same for the same action.
 */
export function sessionEndEnterHint(action: SessionEndNotice["action"]): string {
  return action === "restart" ? ENTER_TO_RESTART_HINT : ENTER_TO_RECONNECT_HINT;
}

/** The label of a session-end notice's primary action (#5910). */
export function sessionEndActionLabel(action: SessionEndNotice["action"]): string {
  return action === "restart" ? t("drop.end.restart") : t("drop.end.reconnect");
}
