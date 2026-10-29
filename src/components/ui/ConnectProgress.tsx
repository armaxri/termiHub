import React, { useEffect, useState } from "react";
import { Ban, Check, CircleAlert, Clock, X } from "lucide-react";
import { ContentOverlay } from "./ContentOverlay";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { formatElapsed } from "@/utils/formatters";
import "./ui.css";

/** Where one connect stage stands. */
export type ConnectStageState = "pending" | "active" | "done" | "failed";

/** One step of a connect (resolve → connect → authenticate → session). */
export interface ConnectStage {
  /** Stable key (e.g. `"auth"`). */
  id: string;
  /** Short visible label (e.g. `"Authenticate"`). */
  label: string;
  /** Current state of the step. */
  state: ConnectStageState;
}

/**
 * Overall phase of the connect: two busy phases (`connecting`, `retrying`) and
 * three resting outcomes (`failed`, `timeout`, `aborted`).
 */
export type ConnectProgressPhase = "connecting" | "retrying" | "failed" | "timeout" | "aborted";

/** Auto-retry bookkeeping shown in the `retrying` phase. */
export interface ConnectAttempt {
  /** 1-based number of the attempt in flight. */
  current: number;
  /** Retry budget, when bounded. */
  max?: number;
  /** Seconds until the next try, while backing off. */
  nextInSeconds?: number;
}

/** Props for {@link ConnectProgress}. */
export interface ConnectProgressProps {
  /** The connect phase. */
  phase: ConnectProgressPhase;
  /** What is being connected to (host, port path, agent name). */
  target: string;
  /** Connection-type label, e.g. `"Telnet"`, `"SSH"`, `"Serial"`. */
  typeLabel: string;
  /** Connection-type glyph (a lucide icon element). */
  typeIcon: React.ReactNode;
  /** Extra facts shown as chips beside the type (port, jump host, baud rate). */
  details?: string[];
  /** Known stages, in order. Omit when the backend reports none. */
  stages?: ConnectStage[];
  /** The live status / last log line. */
  status?: string;
  /** Epoch ms when the attempt started. */
  startedAt: number;
  /** Epoch ms when the attempt times out. Omit for an unbounded wait. */
  deadlineAt?: number;
  /**
   * Fixed "now" (epoch ms) — freezes the readout for tests and screenshots.
   * Omit in the app: the readout then ticks once per second.
   */
  now?: number;
  /** Auto-retry state for the `retrying` phase. */
  attempt?: ConnectAttempt;
  /** Failure body (message + hint) for the resting phases. */
  error?: React.ReactNode;
  /** Action buttons (Abort while busy; Retry / Close tab when resting). */
  actions: React.ReactNode;
  /** Test hook on the root element. */
  "data-testid"?: string;
}

/** Ring geometry (viewBox units): radius and circumference. */
const RING_R = 28;
const RING_C = 2 * Math.PI * RING_R;

const RESTING_ICON: Record<"failed" | "timeout" | "aborted", React.ReactNode> = {
  failed: <CircleAlert size={26} aria-hidden />,
  timeout: <Clock size={26} aria-hidden />,
  aborted: <Ban size={26} aria-hidden />,
};

const RESTING_HEADING: Record<"failed" | "timeout" | "aborted", string> = {
  failed: "Connection failed",
  timeout: "Timed out",
  aborted: "Connection aborted",
};

/** Wall-clock "now", ticking once per second while `active` (unless fixed). */
function useNow(active: boolean, fixed?: number): number {
  const [now, setNow] = useState(() => fixed ?? Date.now());
  useEffect(() => {
    if (fixed !== undefined || !active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active, fixed]);
  return fixed ?? now;
}

/**
 * The progress ring. Its fill is a CSS animation whose negative delay equals
 * the elapsed time at render, so it advances on the compositor clock and never
 * waits on a JS timer; the comet orbit is a pure `transform` animation on an
 * HTML element, the liveness cue that keeps moving even if the main thread
 * stalls. Under reduced motion both animations stop and `--cp-progress`
 * (refreshed every second) sets the fill instead.
 */
function ProgressRing({
  icon,
  elapsedMs,
  totalMs,
  reducedMotion,
}: {
  icon: React.ReactNode;
  elapsedMs: number;
  totalMs?: number;
  reducedMotion: boolean;
}) {
  const determinate = totalMs !== undefined && totalMs > 0;
  const style = determinate
    ? ({
        "--cp-duration": `${totalMs}ms`,
        "--cp-delay": `-${elapsedMs}ms`,
        "--cp-progress": String(Math.min(1, elapsedMs / totalMs)),
        "--cp-circumference": String(RING_C),
      } as React.CSSProperties)
    : undefined;
  const cls = [
    "ui-connect-progress__ring",
    determinate ? "" : "ui-connect-progress__ring--indeterminate",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls} style={style} aria-hidden>
      <svg viewBox="0 0 64 64" className="ui-connect-progress__ring-svg">
        <circle className="ui-connect-progress__ring-track" cx="32" cy="32" r={RING_R} />
        {determinate && (
          <circle
            className="ui-connect-progress__ring-fill"
            cx="32"
            cy="32"
            r={RING_R}
            strokeDasharray={RING_C}
          />
        )}
      </svg>
      {!reducedMotion && (
        <span className="ui-connect-progress__comet">
          <span className="ui-connect-progress__comet-dot" />
        </span>
      )}
      <span className="ui-connect-progress__ring-icon">{icon}</span>
    </div>
  );
}

/** The horizontal stage stepper. */
function StageStepper({ stages }: { stages: ConnectStage[] }) {
  return (
    <ol className="ui-connect-progress__steps" aria-label="Connection steps">
      {stages.map((s) => (
        <li
          key={s.id}
          className="ui-connect-progress__step"
          data-state={s.state}
          aria-current={s.state === "active" ? "step" : undefined}
        >
          <span className="ui-connect-progress__step-dot" aria-hidden>
            {s.state === "done" && <Check size={10} strokeWidth={3} />}
            {s.state === "failed" && <X size={10} strokeWidth={3} />}
          </span>
          <span className="ui-connect-progress__step-label">{s.label}</span>
        </li>
      ))}
    </ol>
  );
}

/** "4s elapsed · times out in 86s", or "Attempt 2 of 5 · next try in 3s". */
function timeLine(
  phase: ConnectProgressPhase,
  startedAt: number,
  deadlineAt: number | undefined,
  now: number,
  attempt?: ConnectAttempt
): string {
  const elapsedMs = Math.max(0, now - startedAt);
  if (phase === "retrying" && attempt) {
    const of = attempt.max ? ` of ${attempt.max}` : "";
    const next =
      attempt.nextInSeconds !== undefined ? ` · next try in ${attempt.nextInSeconds}s` : "";
    return `Attempt ${attempt.current}${of}${next}`;
  }
  const elapsed = `${formatElapsed(Math.floor(elapsedMs / 1000))} elapsed`;
  if (deadlineAt === undefined) return elapsed;
  if (phase === "timeout") {
    return `Gave up after ${formatElapsed(Math.round((deadlineAt - startedAt) / 1000))}`;
  }
  const remaining = Math.max(0, Math.ceil((deadlineAt - now) / 1000));
  return `${elapsed} · times out in ${remaining}s`;
}

/**
 * PROTOTYPE (#5068 phase 1, not wired into production): the one shared
 * connecting surface for every connection type — a progress ring that tracks
 * the timeout, a stage stepper, the live status line, and one primary action.
 * Composes {@link ContentOverlay} for layout, focus and live-region behaviour.
 */
export function ConnectProgress({
  phase,
  target,
  typeLabel,
  typeIcon,
  details = [],
  stages,
  status,
  startedAt,
  deadlineAt,
  now: fixedNow,
  attempt,
  error,
  actions,
  "data-testid": testId,
}: ConnectProgressProps): React.ReactElement {
  const busy = phase === "connecting" || phase === "retrying";
  const reducedMotion = usePrefersReducedMotion();
  const now = useNow(busy, fixedNow);
  const elapsedMs = Math.max(0, now - startedAt);
  const totalMs = deadlineAt !== undefined ? deadlineAt - startedAt : undefined;

  const icon = busy ? (
    <ProgressRing
      icon={typeIcon}
      elapsedMs={elapsedMs}
      totalMs={phase === "retrying" ? undefined : totalMs}
      reducedMotion={reducedMotion}
    />
  ) : (
    <span className="ui-connect-progress__badge" aria-hidden>
      {RESTING_ICON[phase]}
    </span>
  );
  const heading = busy
    ? `${phase === "retrying" ? "Reconnecting" : "Connecting"} to ${target}`
    : RESTING_HEADING[phase];

  return (
    <div className="ui-connect-progress" data-phase={phase} data-testid={testId}>
      <ContentOverlay
        icon={icon}
        busy={busy}
        heading={heading}
        announce={busy ? undefined : phase === "aborted" ? "polite" : "assertive"}
        subheading={
          <span className="ui-connect-progress__meta">
            <span className="ui-chip">
              <span className="ui-chip__icon" aria-hidden>
                {typeIcon}
              </span>
              <span className="ui-chip__label">{typeLabel}</span>
            </span>
            {!busy && <span className="ui-chip">{target}</span>}
            {details.map((d) => (
              <span key={d} className="ui-chip">
                {d}
              </span>
            ))}
          </span>
        }
        actions={actions}
      >
        {stages && stages.length > 0 && <StageStepper stages={stages} />}
        {status && (
          <p className="ui-connect-progress__status">
            <span className="ui-connect-progress__status-text">{status}</span>
          </p>
        )}
        {error && <div className="ui-connect-progress__error">{error}</div>}
        <p className="ui-connect-progress__time" data-testid="connect-progress-time">
          {timeLine(phase, startedAt, deadlineAt, now, attempt)}
        </p>
      </ContentOverlay>
    </div>
  );
}
