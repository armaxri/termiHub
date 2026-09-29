/**
 * The process-kill signal menu model (#3209).
 *
 * Pure helpers behind the signal picker in {@link ProcessTablePanel}: the signal
 * list (mirroring the backend `KillSignal`), which signals are destructive, and
 * which ones a host can deliver. Kept separate from the component so the
 * per-platform rules are unit-testable on any CI host.
 */
import { t, type MessageId } from "@/i18n/catalog";
import type { Platform } from "@/utils/platform";
import type { KillSignal } from "@/types/monitoring";

/** Every signal the backend accepts, in menu order. TERM, the default, leads. */
export const KILL_SIGNALS: readonly KillSignal[] = [
  "term",
  "kill",
  "int",
  "hup",
  "quit",
  "stop",
  "cont",
  "usr1",
  "usr2",
];

/** The signal the kill action preselects. */
export const DEFAULT_KILL_SIGNAL: KillSignal = "term";

/** The `SIG`-prefixed name of a signal, e.g. `"SIGTERM"`. */
export function signalName(signal: KillSignal): string {
  return `SIG${signal.toUpperCase()}`;
}

/** The picker label for a signal (name plus a short meaning), from the catalog. */
export function signalOptionLabel(signal: KillSignal): string {
  return t(`process.signal.${signal}` as MessageId);
}

/**
 * Signals that take effect at once and cannot be caught or ignored: SIGKILL
 * ends the process, SIGSTOP freezes it. The confirmation warns explicitly.
 */
export function isDestructiveSignal(signal: KillSignal): boolean {
  return signal === "kill" || signal === "stop";
}

/**
 * Whether the session's host can only terminate processes. That is a local
 * session on a Windows desktop: Windows has no POSIX signals. Remote, WSL and
 * agent-hosted sessions run a POSIX `kill`, so they keep the full menu (the
 * backend still rejects a signal a host cannot deliver with a clear error).
 */
export function isTerminateOnlyHost(connectionType: string | null, platform: Platform): boolean {
  return connectionType === "local" && platform === "windows";
}

/** Whether `signal` can be sent to a host with the given capability. */
export function isSignalAvailable(signal: KillSignal, terminateOnly: boolean): boolean {
  return !terminateOnly || signal === "term" || signal === "kill";
}
