import { useCallback, useEffect, useRef, useState } from "react";
import { WifiOff } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useSessionAutoReconnect } from "@/store/useSessionLifecycle";
import { Button, LiveRegion, Spinner } from "@/components/ui";
import { RECONNECTING_HEADING, reconnectAttemptLabel } from "@/utils/reconnectStatus";
import "./TerminalReconnectStrip.css";

interface TerminalReconnectStripProps {
  tabId: string;
  /**
   * The reconnect-trigger cause shown while a (non-loop) reconnect is in flight
   * (#2442), if any.
   */
  reconnectTriggerError?: string;
}

/** What the strip says the user's typing does while the loop is running. */
export const INPUT_PAUSED_NOTE = "Typing is paused until the session reconnects.";

/**
 * Whether a keydown is "typing" — a key the user expects to reach the shell.
 * Modifier shortcuts (copy, select-all, app shortcuts) and bare modifiers are
 * not, so selecting and copying the scrollback never trips the nudge.
 */
function isTypingKey(e: KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (e.key.length === 1) return true;
  return e.key === "Enter" || e.key === "Backspace" || e.key === "Delete" || e.key === "Tab";
}

/**
 * Non-blocking reconnect strip (#5179): shown at the top of the terminal while a
 * reconnect is running, instead of the full-inset blurred overlay. The scrollback
 * underneath stays scrollable and selectable, so the user can read and copy the
 * last lines of the dropped session without cancelling the reconnect.
 *
 * Covers both the agentless auto-reconnect loop (#1962: countdown + attempt n/N
 * + Cancel, in its `waiting` and `connecting` phases) and a plain in-flight
 * reconnect (spinner + Stop). Terminal states (exhausted / failed / session
 * lost) keep the full {@link TerminalDisconnectOverlay}.
 *
 * Input: the dropped session has no backend while the loop runs, so keystrokes
 * typed into the terminal are discarded — as they were behind the old overlay.
 * The strip says so up front and, when the user types anyway, highlights the
 * note and announces it once, so typing never silently goes nowhere.
 */
export function TerminalReconnectStrip({
  tabId,
  reconnectTriggerError,
}: TerminalReconnectStripProps) {
  const auto = useSessionAutoReconnect(tabId);
  const cancelAutoReconnect = useAppStore((s) => s.cancelAutoReconnect);
  const stripRef = useRef<HTMLDivElement>(null);
  const waiting = auto?.phase === "waiting";
  // The loop drops typed input; a plain (agent) reconnect may not, so only the
  // loop variant makes the input claim.
  const inLoop = auto !== undefined;

  // Tick so the countdown stays live; only while a backoff window is open. A new
  // window (the strip stays mounted across attempts) re-reads the clock at once,
  // so the first frame never shows a countdown computed from a stale `now`.
  const nextAttemptAt = waiting ? auto.nextAttemptAt : 0;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!nextAttemptAt) return;
    const tick = () => setNow(Date.now());
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [nextAttemptAt]);

  const handleCancel = useCallback(() => {
    cancelAutoReconnect(tabId);
  }, [tabId, cancelAutoReconnect]);

  // Typing into this tab's terminal while the loop runs: flag it so the note is
  // emphasised and announced. Scoped to the strip's own terminal slot
  // and excluding the strip itself, so Cancel's keyboard use never trips it.
  const [typedWhilePaused, setTypedWhilePaused] = useState(false);
  useEffect(() => {
    if (!inLoop) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const strip = stripRef.current;
      const slot = strip?.closest(".terminal-container") ?? strip?.parentElement;
      const target = e.target;
      if (!strip || !slot || !(target instanceof Node)) return;
      if (!slot.contains(target) || strip.contains(target)) return;
      if (isTypingKey(e)) setTypedWhilePaused(true);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [inLoop]);

  const attemptLabel = auto
    ? // `attempt` counts the attempts already started: while waiting the
      // countdown is for the next one, while connecting it is the current one.
      reconnectAttemptLabel(waiting ? auto.attempt + 1 : auto.attempt, auto.maxAttempts)
    : null;
  const secondsLeft = waiting ? Math.max(0, Math.ceil((nextAttemptAt - now) / 1000)) : 0;

  const heading = inLoop ? RECONNECTING_HEADING : "Reconnecting…";
  const status = !auto
    ? "Connection lost. Attempting to reconnect automatically."
    : waiting && secondsLeft > 0
      ? `Retrying in ${secondsLeft}s · ${attemptLabel}`
      : `Reconnecting… · ${attemptLabel}`;

  // Announce the state and each attempt change — never the per-second countdown.
  // A plain reconnect has no ticking text, so its status line is announced too.
  const announcement = inLoop
    ? [`${heading} ${attemptLabel}.`, typedWhilePaused ? INPUT_PAUSED_NOTE : null]
        .filter(Boolean)
        .join(" ")
    : `${heading} ${status}`;

  return (
    <div
      ref={stripRef}
      className="terminal-reconnect-strip"
      // The root id is shared with the full overlay so the system-test harness
      // finds "the disconnect notice" for every variant.
      data-testid="terminal-disconnect-overlay"
      data-variant="strip"
      role="region"
      aria-label={heading}
    >
      <LiveRegion message={announcement} data-testid="terminal-reconnect-strip-announcement" />
      {waiting ? (
        <WifiOff size={12} className="terminal-reconnect-strip__icon" aria-hidden="true" />
      ) : (
        <Spinner size={12} label={null} className="terminal-reconnect-strip__icon" />
      )}
      <div className="terminal-reconnect-strip__text">
        <div className="terminal-reconnect-strip__line">
          <span className="terminal-reconnect-strip__heading">{heading}</span>
          {inLoop ? (
            <span
              className="terminal-reconnect-strip__status"
              data-testid="terminal-auto-reconnect-countdown"
            >
              {status}
            </span>
          ) : (
            <span className="terminal-reconnect-strip__status">{status}</span>
          )}
        </div>
        {inLoop && (
          <div className="terminal-reconnect-strip__line terminal-reconnect-strip__note">
            <span
              className={
                typedWhilePaused
                  ? "terminal-reconnect-strip__input terminal-reconnect-strip__input--typed"
                  : "terminal-reconnect-strip__input"
              }
              data-testid="terminal-reconnect-input-paused"
            >
              {INPUT_PAUSED_NOTE}
            </span>{" "}
            <span>
              Local scrollback is preserved. Without an agent, the remote shell state is not
              restored — a fresh shell opens.
            </span>
            {auto.onReconnectCommand && (
              <span data-testid="terminal-auto-reconnect-command">
                {" "}
                Will run <code>{auto.onReconnectCommand}</code> on reconnect.
              </span>
            )}
          </div>
        )}
        {reconnectTriggerError && (
          <div
            className="terminal-reconnect-strip__line terminal-reconnect-strip__error"
            data-testid="terminal-disconnect-trigger-error-box"
          >
            {reconnectTriggerError}
          </div>
        )}
      </div>
      {/* Literal testids per control, so the static testid scan (and the
          system-test harness) sees both. */}
      {waiting ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={handleCancel}
          data-testid="terminal-auto-reconnect-cancel-btn"
        >
          Cancel
        </Button>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          onClick={handleCancel}
          data-testid="terminal-disconnect-stop-btn"
        >
          Stop
        </Button>
      )}
    </div>
  );
}
