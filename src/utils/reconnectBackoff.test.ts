import { describe, it, expect } from "vitest";
import {
  DEFAULT_BACKOFF,
  backoffDelay,
  nextReconnectDelay,
  shouldGiveUp,
  reconnectReducer,
  initialReconnectState,
  isActiveReconnectPhase,
  type BackoffConfig,
  type ReconnectState,
} from "./reconnectBackoff";

/** Deterministic config with jitter disabled, for exact delay assertions. */
const NO_JITTER: BackoffConfig = {
  baseDelayMs: 1_000,
  factor: 2,
  maxDelayMs: 8_000,
  maxAttempts: 5,
  jitterRatio: 0,
};

describe("reconnectBackoff — backoffDelay", () => {
  it("returns the base delay for the first attempt", () => {
    expect(backoffDelay(1, NO_JITTER)).toBe(1_000);
  });

  it("grows exponentially by the factor per attempt", () => {
    expect(backoffDelay(2, NO_JITTER)).toBe(2_000);
    expect(backoffDelay(3, NO_JITTER)).toBe(4_000);
    expect(backoffDelay(4, NO_JITTER)).toBe(8_000);
  });

  it("caps at maxDelayMs", () => {
    // Attempt 5 would be 16_000 but is clamped to the 8_000 ceiling.
    expect(backoffDelay(5, NO_JITTER)).toBe(8_000);
    expect(backoffDelay(50, NO_JITTER)).toBe(8_000);
  });

  it("treats attempt < 1 as the first attempt (never sub-base)", () => {
    expect(backoffDelay(0, NO_JITTER)).toBe(1_000);
    expect(backoffDelay(-3, NO_JITTER)).toBe(1_000);
  });
});

describe("reconnectBackoff — nextReconnectDelay (jitter)", () => {
  it("equals the plain backoff when jitter is disabled", () => {
    expect(nextReconnectDelay(3, NO_JITTER, () => 0.5)).toBe(4_000);
  });

  it("applies symmetric jitter within ±jitterRatio", () => {
    const cfg: BackoffConfig = { ...NO_JITTER, jitterRatio: 0.2 };
    // rand=0 → factor (1 + (-0.2)) = 0.8 → 800 for base 1000
    expect(nextReconnectDelay(1, cfg, () => 0)).toBe(800);
    // rand→1 (upper bound) → factor (1 + 0.2) = 1.2 → 1200
    expect(nextReconnectDelay(1, cfg, () => 0.999999)).toBeCloseTo(1_200, -1);
    // rand=0.5 → no swing → exactly base
    expect(nextReconnectDelay(1, cfg, () => 0.5)).toBe(1_000);
  });

  it("never returns a negative delay", () => {
    const cfg: BackoffConfig = { ...NO_JITTER, jitterRatio: 2 };
    expect(nextReconnectDelay(1, cfg, () => 0)).toBeGreaterThanOrEqual(0);
  });

  it("keeps jittered delays bounded across the full rand range", () => {
    const cfg: BackoffConfig = { ...DEFAULT_BACKOFF };
    for (let r = 0; r <= 1; r += 0.05) {
      const d = nextReconnectDelay(3, cfg, () => r);
      const base = backoffDelay(3, cfg);
      expect(d).toBeGreaterThanOrEqual(Math.round(base * (1 - cfg.jitterRatio)) - 1);
      expect(d).toBeLessThanOrEqual(Math.round(base * (1 + cfg.jitterRatio)) + 1);
    }
  });
});

describe("reconnectBackoff — shouldGiveUp", () => {
  it("gives up once attempts reach maxAttempts", () => {
    expect(shouldGiveUp(4, NO_JITTER)).toBe(false);
    expect(shouldGiveUp(5, NO_JITTER)).toBe(true);
    expect(shouldGiveUp(6, NO_JITTER)).toBe(true);
  });

  it("never gives up when maxAttempts is 0 (unbounded)", () => {
    const cfg: BackoffConfig = { ...NO_JITTER, maxAttempts: 0 };
    expect(shouldGiveUp(1_000, cfg)).toBe(false);
  });
});

describe("reconnectBackoff — reconnectReducer transitions", () => {
  const rand = () => 0.5; // no swing → deterministic delays

  it("drop from idle arms the first backoff window", () => {
    const s = reconnectReducer(initialReconnectState, "drop", NO_JITTER, rand);
    expect(s.phase).toBe("waiting");
    expect(s.attempt).toBe(0);
    expect(s.delayMs).toBe(1_000);
  });

  it("attempt from waiting starts a connection and counts it", () => {
    const waiting = reconnectReducer(initialReconnectState, "drop", NO_JITTER, rand);
    const connecting = reconnectReducer(waiting, "attempt", NO_JITTER, rand);
    expect(connecting.phase).toBe("connecting");
    expect(connecting.attempt).toBe(1);
    expect(connecting.delayMs).toBe(0);
  });

  it("success from connecting settles the loop and resets the counter", () => {
    let s: ReconnectState = reconnectReducer(initialReconnectState, "drop", NO_JITTER, rand);
    s = reconnectReducer(s, "attempt", NO_JITTER, rand);
    s = reconnectReducer(s, "success", NO_JITTER, rand);
    expect(s.phase).toBe("connected");
    expect(s.attempt).toBe(0);
  });

  it("failure from connecting backs off with a longer delay for the next attempt", () => {
    let s: ReconnectState = reconnectReducer(initialReconnectState, "drop", NO_JITTER, rand);
    s = reconnectReducer(s, "attempt", NO_JITTER, rand); // attempt 1
    s = reconnectReducer(s, "failure", NO_JITTER, rand);
    expect(s.phase).toBe("waiting");
    expect(s.attempt).toBe(1);
    // Next attempt is #2 → 2_000ms.
    expect(s.delayMs).toBe(2_000);
  });

  it("walks a full escalating backoff schedule until give-up", () => {
    const delays: number[] = [];
    let s: ReconnectState = reconnectReducer(initialReconnectState, "drop", NO_JITTER, rand);
    delays.push(s.delayMs);
    // 5 attempts allowed; the 5th failure gives up.
    for (let i = 0; i < 5; i++) {
      s = reconnectReducer(s, "attempt", NO_JITTER, rand);
      expect(s.phase).toBe("connecting");
      s = reconnectReducer(s, "failure", NO_JITTER, rand);
      if (s.phase === "waiting") delays.push(s.delayMs);
    }
    expect(s.phase).toBe("gaveup");
    expect(s.attempt).toBe(5);
    // Escalating, capped at 8_000: 1000, 2000, 4000, 8000, 8000.
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 8_000]);
  });

  it("cancel from any phase gives up", () => {
    const waiting = reconnectReducer(initialReconnectState, "drop", NO_JITTER, rand);
    expect(reconnectReducer(waiting, "cancel", NO_JITTER, rand).phase).toBe("gaveup");
    const connecting = reconnectReducer(waiting, "attempt", NO_JITTER, rand);
    expect(reconnectReducer(connecting, "cancel", NO_JITTER, rand).phase).toBe("gaveup");
  });

  it("a re-drop after a successful reconnect restarts the loop from attempt 1", () => {
    let s: ReconnectState = reconnectReducer(initialReconnectState, "drop", NO_JITTER, rand);
    s = reconnectReducer(s, "attempt", NO_JITTER, rand);
    s = reconnectReducer(s, "success", NO_JITTER, rand);
    expect(s.phase).toBe("connected");
    s = reconnectReducer(s, "drop", NO_JITTER, rand);
    expect(s.phase).toBe("waiting");
    expect(s.delayMs).toBe(1_000); // fresh attempt-1 delay
  });

  it("ignores stray events that do not match the current phase", () => {
    // attempt while idle is a no-op
    expect(reconnectReducer(initialReconnectState, "attempt", NO_JITTER, rand)).toEqual(
      initialReconnectState
    );
    // success while idle is a no-op
    expect(reconnectReducer(initialReconnectState, "success", NO_JITTER, rand)).toEqual(
      initialReconnectState
    );
    // duplicate drop while waiting does not re-arm
    const waiting = reconnectReducer(initialReconnectState, "drop", NO_JITTER, rand);
    expect(reconnectReducer(waiting, "drop", NO_JITTER, rand)).toEqual(waiting);
  });

  it("with unbounded retries never reaches gaveup on failure", () => {
    const cfg: BackoffConfig = { ...NO_JITTER, maxAttempts: 0 };
    let s: ReconnectState = reconnectReducer(initialReconnectState, "drop", cfg, rand);
    for (let i = 0; i < 100; i++) {
      s = reconnectReducer(s, "attempt", cfg, rand);
      s = reconnectReducer(s, "failure", cfg, rand);
      expect(s.phase).toBe("waiting");
    }
    // Only Cancel stops an unbounded loop.
    expect(reconnectReducer(s, "cancel", cfg, rand).phase).toBe("gaveup");
  });
});

describe("reconnectBackoff — isActiveReconnectPhase", () => {
  it("is true while waiting or connecting", () => {
    expect(isActiveReconnectPhase("waiting")).toBe(true);
    expect(isActiveReconnectPhase("connecting")).toBe(true);
  });

  it("is false when idle, connected, or gaveup", () => {
    expect(isActiveReconnectPhase("idle")).toBe(false);
    expect(isActiveReconnectPhase("connected")).toBe(false);
    expect(isActiveReconnectPhase("gaveup")).toBe(false);
  });
});
