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

/** The strip heading while an automatic reconnect runs. */
export function reconnectHeadingFor(transport: DropTransport): string {
  if (transport === "serial") return t("drop.heading.serial");
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
 * "— connection closed by server hh:mm:ss —" (#5696); any real process exit
 * keeps "[Process exited…]".
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
    if (transport === "serial") return tf("drop.separator.serial", { time });
    if (endCause === "remote_closed" && (transport === "ssh" || transport === "telnet")) {
      return tf("drop.separator.remoteClosed", { time });
    }
    return tf("drop.separator.network", { time });
  }
  return exitCode === null ? "[Process exited]" : `[Process exited with code ${exitCode}]`;
}

/** The marker written after a successful reconnect (#5660). */
export function reconnectedMarker(at: Date): string {
  return tf("drop.separator.reconnected", { time: formatClock(at) });
}
