import { describe, it, expect } from "vitest";
import type { ProjectedSessionStatus } from "@/store/sessionBridge";
import {
  resolveEstablishmentPlan,
  type EstablishmentPlan,
  type EstablishmentPlanInput,
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
