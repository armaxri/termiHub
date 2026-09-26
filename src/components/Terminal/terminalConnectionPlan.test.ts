import { describe, it, expect } from "vitest";
import type { BackendAgentReconnectOutcome, ProjectedSessionStatus } from "@/store/sessionBridge";
import {
  resolveEstablishmentPlan,
  resolveAgentSpawnAction,
  resolveBackendRedriveOutcome,
  classifyExitReason,
  type EstablishmentPlan,
  type EstablishmentPlanInput,
  type AgentSpawnAction,
  type AgentSpawnActionInput,
  type BackendRedriveAction,
} from "./terminalConnectionPlan";

/** Base snapshot: an initial mount with no session — the plain fresh-create case. */
function baseInput(overrides: Partial<EstablishmentPlanInput> = {}): EstablishmentPlanInput {
  return {
    isReconnect: false,
    forceFresh: false,
    hasPersistentConnection: false,
    regionStatus: undefined,
    initialSessionId: null,
    replayScrollbackOnAttach: false,
    ...overrides,
  };
}

describe("resolveEstablishmentPlan", () => {
  describe("initial mount (isReconnect=false)", () => {
    it("with no initial session id → freshCreate", () => {
      expect(resolveEstablishmentPlan(baseInput())).toEqual<EstablishmentPlan>({
        kind: "freshCreate",
      });
    });

    it("with an initial session id and no persistent/replay → reattach, replay=none", () => {
      expect(
        resolveEstablishmentPlan(baseInput({ initialSessionId: "sess-1" }))
      ).toEqual<EstablishmentPlan>({
        kind: "reattach",
        sessionId: "sess-1",
        replay: "none",
      });
    });

    it("with a persistent connection → reattach, replay=persistent (persistent wins over moved)", () => {
      expect(
        resolveEstablishmentPlan(
          baseInput({
            initialSessionId: "sess-1",
            hasPersistentConnection: true,
            replayScrollbackOnAttach: true,
          })
        )
      ).toEqual<EstablishmentPlan>({
        kind: "reattach",
        sessionId: "sess-1",
        replay: "persistent",
      });
    });

    it("with only replay-scrollback (moved session, #1900) → reattach, replay=moved", () => {
      expect(
        resolveEstablishmentPlan(
          baseInput({ initialSessionId: "sess-1", replayScrollbackOnAttach: true })
        )
      ).toEqual<EstablishmentPlan>({
        kind: "reattach",
        sessionId: "sess-1",
        replay: "moved",
      });
    });

    it("a stale region status does not divert the initial-mount reattach", () => {
      // On the initial mount the region status is never consulted; only isReconnect does.
      expect(
        resolveEstablishmentPlan(
          baseInput({ initialSessionId: "sess-1", regionStatus: "reconnecting" })
        )
      ).toEqual<EstablishmentPlan>({
        kind: "reattach",
        sessionId: "sess-1",
        replay: "none",
      });
    });
  });

  describe("reconnect (isReconnect=true)", () => {
    it("forceFresh → freshCreate (one-shot 'start new shell', #2512)", () => {
      // forceFresh short-circuits every re-attach branch, even a persistent tab
      // and even a region that is reconnecting.
      expect(
        resolveEstablishmentPlan(
          baseInput({
            isReconnect: true,
            forceFresh: true,
            hasPersistentConnection: true,
            regionStatus: "reconnecting",
            initialSessionId: "corpse",
          })
        )
      ).toEqual<EstablishmentPlan>({ kind: "freshCreate" });
    });

    it("persistent connection → restartPersistent (before the region check)", () => {
      expect(
        resolveEstablishmentPlan(
          baseInput({
            isReconnect: true,
            hasPersistentConnection: true,
            regionStatus: "reconnecting",
            initialSessionId: "corpse",
          })
        )
      ).toEqual<EstablishmentPlan>({ kind: "restartPersistent" });
    });

    it("region reconnecting (non-persistent) → awaitBackendRedrive", () => {
      expect(
        resolveEstablishmentPlan(
          baseInput({
            isReconnect: true,
            regionStatus: "reconnecting",
            initialSessionId: "corpse",
          })
        )
      ).toEqual<EstablishmentPlan>({ kind: "awaitBackendRedrive" });
    });

    it("user-initiated reconnect (region not reconnecting) → freshCreate", () => {
      expect(
        resolveEstablishmentPlan(
          baseInput({ isReconnect: true, regionStatus: "disconnected", initialSessionId: "corpse" })
        )
      ).toEqual<EstablishmentPlan>({ kind: "freshCreate" });
    });

    it("user-initiated reconnect with no region status → freshCreate", () => {
      expect(
        resolveEstablishmentPlan(
          baseInput({ isReconnect: true, regionStatus: undefined, initialSessionId: "corpse" })
        )
      ).toEqual<EstablishmentPlan>({ kind: "freshCreate" });
    });
  });

  describe("corpse guard — a reconnect NEVER reattaches to the mount-time session id", () => {
    // Across every combination of the remaining inputs, a reconnect must never
    // return a `reattach` plan (which would wire the tab to the dead mount-time id).
    const statuses: (ProjectedSessionStatus | undefined)[] = [
      undefined,
      "connecting",
      "connected",
      "disconnected",
      "reconnecting",
      "failed",
      "authFailed",
      "sessionLost",
    ];
    for (const forceFresh of [false, true]) {
      for (const hasPersistentConnection of [false, true]) {
        for (const replayScrollbackOnAttach of [false, true]) {
          for (const regionStatus of statuses) {
            it(`reconnect (forceFresh=${forceFresh}, persistent=${hasPersistentConnection}, replay=${replayScrollbackOnAttach}, status=${regionStatus}) never reattaches`, () => {
              const plan = resolveEstablishmentPlan(
                baseInput({
                  isReconnect: true,
                  forceFresh,
                  hasPersistentConnection,
                  replayScrollbackOnAttach,
                  regionStatus,
                  // A live mount-time id that MUST NOT be reattached to on reconnect.
                  initialSessionId: "corpse-session-id",
                })
              );
              expect(plan.kind).not.toBe("reattach");
            });
          }
        }
      }
    }
  });

  describe("never fall-through — region reconnecting always awaits the backend redrive", () => {
    // The most dangerous fall-through: a region-reconnecting tab must resolve to
    // awaitBackendRedrive and NEVER to freshCreate / reattach, so the client
    // create loop never double-drives the transport the backend is re-establishing.
    it("region=reconnecting, non-persistent, non-forceFresh ⇒ awaitBackendRedrive", () => {
      const plan = resolveEstablishmentPlan(
        baseInput({
          isReconnect: true,
          regionStatus: "reconnecting",
          initialSessionId: "corpse",
        })
      );
      expect(plan.kind).toBe("awaitBackendRedrive");
      expect(plan.kind).not.toBe("freshCreate");
      expect(plan.kind).not.toBe("reattach");
    });

    it("forceFresh takes precedence over region=reconnecting (explicit user choice)", () => {
      // The one exception: an explicit "start new shell" overrides the redrive.
      const plan = resolveEstablishmentPlan(
        baseInput({
          isReconnect: true,
          forceFresh: true,
          regionStatus: "reconnecting",
          initialSessionId: "corpse",
        })
      );
      expect(plan.kind).toBe("freshCreate");
    });

    it("persistent takes precedence over region=reconnecting (restart, not redrive)", () => {
      const plan = resolveEstablishmentPlan(
        baseInput({
          isReconnect: true,
          hasPersistentConnection: true,
          regionStatus: "reconnecting",
          initialSessionId: "corpse",
        })
      );
      expect(plan.kind).toBe("restartPersistent");
    });
  });
});

const MAX_AGENT_SPAWN_ATTEMPTS = 5;

/** Base snapshot: agent up, first attempt — the plain retry case. */
function baseSpawnInput(overrides: Partial<AgentSpawnActionInput> = {}): AgentSpawnActionInput {
  return {
    agentState: "connected",
    attempt: 0,
    maxAttempts: MAX_AGENT_SPAWN_ATTEMPTS,
    ...overrides,
  };
}

describe("resolveAgentSpawnAction", () => {
  describe("agent transport state decides before the attempt count", () => {
    it("connecting → waitForAgent (regardless of attempt)", () => {
      for (const attempt of [0, 3, MAX_AGENT_SPAWN_ATTEMPTS, MAX_AGENT_SPAWN_ATTEMPTS + 10]) {
        expect(
          resolveAgentSpawnAction(baseSpawnInput({ agentState: "connecting", attempt }))
        ).toEqual<AgentSpawnAction>({ kind: "waitForAgent" });
      }
    });

    it("reconnecting → waitForAgent (regardless of attempt)", () => {
      for (const attempt of [0, 3, MAX_AGENT_SPAWN_ATTEMPTS, MAX_AGENT_SPAWN_ATTEMPTS + 10]) {
        expect(
          resolveAgentSpawnAction(baseSpawnInput({ agentState: "reconnecting", attempt }))
        ).toEqual<AgentSpawnAction>({ kind: "waitForAgent" });
      }
    });

    it("disconnected → reconnectAgentThenWait (regardless of attempt, even when exhausted)", () => {
      for (const attempt of [0, 3, MAX_AGENT_SPAWN_ATTEMPTS, MAX_AGENT_SPAWN_ATTEMPTS + 10]) {
        expect(
          resolveAgentSpawnAction(baseSpawnInput({ agentState: "disconnected", attempt }))
        ).toEqual<AgentSpawnAction>({ kind: "reconnectAgentThenWait" });
      }
    });
  });

  describe("agent up (connected / undefined) — bounded retry vs give-up", () => {
    for (const agentState of ["connected", undefined] as const) {
      const label = agentState ?? "undefined (agent not found)";

      it(`${label}: attempt below the max retries → retryAfterDelay(attempt+1)`, () => {
        for (let attempt = 0; attempt < MAX_AGENT_SPAWN_ATTEMPTS; attempt++) {
          expect(
            resolveAgentSpawnAction(baseSpawnInput({ agentState, attempt }))
          ).toEqual<AgentSpawnAction>({ kind: "retryAfterDelay", attempt: attempt + 1 });
        }
      });

      it(`${label}: the give-up boundary — attempt == maxAttempts-1 retries, attempt == maxAttempts gives up`, () => {
        // Matches the former inline `attempt++; if (attempt > MAX_AGENT_SPAWN_ATTEMPTS)`:
        // the pre-increment attempt gives up exactly when attempt >= maxAttempts.
        expect(
          resolveAgentSpawnAction(
            baseSpawnInput({ agentState, attempt: MAX_AGENT_SPAWN_ATTEMPTS - 1 })
          )
        ).toEqual<AgentSpawnAction>({
          kind: "retryAfterDelay",
          attempt: MAX_AGENT_SPAWN_ATTEMPTS,
        });
        expect(
          resolveAgentSpawnAction(baseSpawnInput({ agentState, attempt: MAX_AGENT_SPAWN_ATTEMPTS }))
        ).toEqual<AgentSpawnAction>({ kind: "giveUp" });
      });

      it(`${label}: attempts past the max continue to give up`, () => {
        for (const attempt of [
          MAX_AGENT_SPAWN_ATTEMPTS,
          MAX_AGENT_SPAWN_ATTEMPTS + 1,
          MAX_AGENT_SPAWN_ATTEMPTS + 5,
        ]) {
          expect(
            resolveAgentSpawnAction(baseSpawnInput({ agentState, attempt }))
          ).toEqual<AgentSpawnAction>({ kind: "giveUp" });
        }
      });
    }
  });

  describe("exhaustive agentState × attempt table", () => {
    const states: AgentSpawnActionInput["agentState"][] = [
      "connecting",
      "reconnecting",
      "disconnected",
      "connected",
      undefined,
    ];
    for (const agentState of states) {
      for (const attempt of [0, 1, 4, 5, 6]) {
        it(`agentState=${agentState ?? "undefined"}, attempt=${attempt}`, () => {
          const action = resolveAgentSpawnAction(baseSpawnInput({ agentState, attempt }));
          if (agentState === "connecting" || agentState === "reconnecting") {
            expect(action).toEqual<AgentSpawnAction>({ kind: "waitForAgent" });
          } else if (agentState === "disconnected") {
            expect(action).toEqual<AgentSpawnAction>({ kind: "reconnectAgentThenWait" });
          } else if (attempt < MAX_AGENT_SPAWN_ATTEMPTS) {
            expect(action).toEqual<AgentSpawnAction>({
              kind: "retryAfterDelay",
              attempt: attempt + 1,
            });
          } else {
            expect(action).toEqual<AgentSpawnAction>({ kind: "giveUp" });
          }
        });
      }
    }
  });
});

describe("resolveBackendRedriveOutcome", () => {
  describe("cancel takes precedence (abandon — drive nothing)", () => {
    it("outcome=canceled → abandon", () => {
      expect(
        resolveBackendRedriveOutcome({ outcome: { kind: "canceled" }, isCanceled: false })
      ).toEqual<BackendRedriveAction>({ kind: "abandon" });
    });

    it("isCanceled=true short-circuits even a reattach outcome", () => {
      expect(
        resolveBackendRedriveOutcome({
          outcome: { kind: "reattach", sessionId: "sess-1" },
          isCanceled: true,
        })
      ).toEqual<BackendRedriveAction>({ kind: "abandon" });
    });

    it("isCanceled=true short-circuits a giveup outcome (no settle)", () => {
      expect(
        resolveBackendRedriveOutcome({
          outcome: { kind: "giveup", error: "boom" },
          isCanceled: true,
        })
      ).toEqual<BackendRedriveAction>({ kind: "abandon" });
    });
  });

  describe("giveup → settleGaveUp with the backend message or the default", () => {
    it("carries the backend error verbatim", () => {
      expect(
        resolveBackendRedriveOutcome({
          outcome: { kind: "giveup", error: "agent exhausted retries" },
          isCanceled: false,
        })
      ).toEqual<BackendRedriveAction>({ kind: "settleGaveUp", error: "agent exhausted retries" });
    });

    it('falls back to "Reconnect failed." when the outcome has no error', () => {
      expect(
        resolveBackendRedriveOutcome({ outcome: { kind: "giveup" }, isCanceled: false })
      ).toEqual<BackendRedriveAction>({ kind: "settleGaveUp", error: "Reconnect failed." });
    });
  });

  describe("sessionLost → settleSessionLost (error dropped, as the caller ignores it)", () => {
    it("with an error present", () => {
      expect(
        resolveBackendRedriveOutcome({
          outcome: { kind: "sessionLost", error: "unrecoverable" },
          isCanceled: false,
        })
      ).toEqual<BackendRedriveAction>({ kind: "settleSessionLost" });
    });

    it("without an error", () => {
      expect(
        resolveBackendRedriveOutcome({ outcome: { kind: "sessionLost" }, isCanceled: false })
      ).toEqual<BackendRedriveAction>({ kind: "settleSessionLost" });
    });
  });

  describe("reattach → reattach with the fresh backend session id", () => {
    it("passes the session id through", () => {
      expect(
        resolveBackendRedriveOutcome({
          outcome: { kind: "reattach", sessionId: "sess-42" },
          isCanceled: false,
        })
      ).toEqual<BackendRedriveAction>({ kind: "reattach", sessionId: "sess-42" });
    });
  });

  describe("exhaustive outcome-kind × isCanceled table", () => {
    const outcomes: BackendAgentReconnectOutcome[] = [
      { kind: "reattach", sessionId: "s" },
      { kind: "giveup", error: "e" },
      { kind: "giveup" },
      { kind: "sessionLost", error: "e" },
      { kind: "sessionLost" },
      { kind: "evicted" },
      { kind: "canceled" },
    ];
    for (const outcome of outcomes) {
      for (const isCanceled of [false, true]) {
        it(`outcome=${outcome.kind}(err=${"error" in outcome ? outcome.error : "-"}), isCanceled=${isCanceled}`, () => {
          const action = resolveBackendRedriveOutcome({ outcome, isCanceled });
          if (isCanceled || outcome.kind === "canceled" || outcome.kind === "evicted") {
            // SM-003: a tab taken over by another desktop rests in `evicted`
            // awaiting an explicit Reclaim — the client drives nothing.
            expect(action).toEqual<BackendRedriveAction>({ kind: "abandon" });
          } else if (outcome.kind === "giveup") {
            expect(action).toEqual<BackendRedriveAction>({
              kind: "settleGaveUp",
              error: outcome.error ?? "Reconnect failed.",
            });
          } else if (outcome.kind === "sessionLost") {
            expect(action).toEqual<BackendRedriveAction>({ kind: "settleSessionLost" });
          } else {
            expect(action).toEqual<BackendRedriveAction>({
              kind: "reattach",
              sessionId: outcome.sessionId,
            });
          }
        });
      }
    }
  });
});

describe("classifyExitReason", () => {
  it("a consumed kill tag wins regardless of exit code → killed", () => {
    expect(classifyExitReason({ wasKilled: true, exitCode: 0 })).toBe("killed");
    expect(classifyExitReason({ wasKilled: true, exitCode: 1 })).toBe("killed");
    expect(classifyExitReason({ wasKilled: true, exitCode: null })).toBe("killed");
  });

  it("not killed, exit code 0 → clean", () => {
    expect(classifyExitReason({ wasKilled: false, exitCode: 0 })).toBe("clean");
  });

  it("not killed, non-zero code → dropped", () => {
    expect(classifyExitReason({ wasKilled: false, exitCode: 1 })).toBe("dropped");
    expect(classifyExitReason({ wasKilled: false, exitCode: 137 })).toBe("dropped");
  });

  it("not killed, unknown (null) code → dropped (null is not === 0)", () => {
    expect(classifyExitReason({ wasKilled: false, exitCode: null })).toBe("dropped");
  });
});
