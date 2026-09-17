/**
 * Shared monotonic version guard for the projection bridges (FES-006).
 *
 * Every `src/store/*Bridge.ts` caches the last projected view it received from its
 * region so a hook that subscribes after the first diff — and the store's own
 * synchronous reads — still see the current picture. A cache like that must never
 * be clobbered by a **stale** (out-of-order / late-delivered) snapshot: an older
 * region version overwriting a newer one would silently regress the UI.
 *
 * The agents / settings / file-browser bridges each grew their own ad-hoc
 * `lastAppliedVersion` compare for exactly this. This helper captures that one
 * semantic in a single, typed, tested place so every bridge guards **consistently**
 * instead of a few carrying a hand-rolled copy and the rest committing verbatim.
 *
 * # Semantics (identical to the pre-existing ad-hoc guards)
 *
 * A snapshot at region `version` is applied only when it is **not strictly older**
 * than the last one applied:
 *
 * - **older** (`version < lastApplied`) → dropped (a stale, out-of-order delivery);
 * - **equal** (`version === lastApplied`) → applied — so an optimistic overlay the
 *   {@link import("@/services/transport").ProjectionClient} re-emits at the *same*
 *   region version still commits (its content changed even though the version did
 *   not); any content-level de-duplication a bridge layers on top is its own
 *   concern, orthogonal to this version gate;
 * - **newer** (`version > lastApplied`) → applied;
 * - the **first** snapshot always applies (the baseline is
 *   {@link NO_VERSION_APPLIED}, which every real region version `>= 0` exceeds).
 *
 * # Why uniform adoption is safe (a no-op that only adds protection)
 *
 * The projection substrate delivers each region's versions **monotonically and in
 * order** to a bridge's change listener: within one `ProjectionClient` a snapshot
 * never regresses the cached version (`adoptSnapshot` ignores an older snapshot), a
 * diff applies only when its `baseVersion` matches the current version, and an
 * optimistic overlay re-emits at the current version — so the version handed to a
 * bridge is always non-decreasing. Against that stream {@link shouldApply} never
 * drops a valid update; the guard only ever fires against a genuinely stale, out-of-
 * order delivery. Adopting it in a bridge that previously committed verbatim is
 * therefore behaviour-preserving on today's substrate and purely adds out-of-order
 * protection.
 *
 * A guard's state is per bridge (one region), so callers create one with
 * {@link makeVersionGuard} and MUST {@link VersionGuard.reset} it whenever the
 * subscription is dropped or the transport is swapped — a fresh `ProjectionClient`
 * restarts at {@link NO_VERSION_APPLIED}, and a stale high water mark would wrongly
 * drop its first snapshot.
 */

/** The "nothing applied yet" baseline — below every real region version (`>= 0`),
 * so the first snapshot always applies. */
export const NO_VERSION_APPLIED = -1;

/** A per-region monotonic version guard (FES-006). See the module docs. */
export interface VersionGuard {
  /**
   * Whether a snapshot at region `version` should be applied. Records `version`
   * as the last applied and returns `true` unless `version` is strictly older
   * than the last applied — a stale, out-of-order delivery — in which case it
   * records nothing and returns `false`. See the module docs for the exact
   * older / equal / newer / first semantics.
   */
  shouldApply(version: number): boolean;
  /**
   * Advance the last-applied version by one. For a synchronous test seed that
   * sets a bridge's cached view directly (bypassing {@link shouldApply}) and must
   * not then have a later real diff at the next version treated as stale —
   * mirrors the `lastAppliedVersion += 1` the agents region test seam used. Not
   * used in production code.
   */
  bump(): void;
  /** Reset to the {@link NO_VERSION_APPLIED} baseline (a subscription drop or
   * transport swap — the next `ProjectionClient` restarts its versions). */
  reset(): void;
}

/**
 * Create a fresh {@link VersionGuard} at the {@link NO_VERSION_APPLIED} baseline.
 * One per bridge (each bridge owns a single region).
 */
export function makeVersionGuard(): VersionGuard {
  let lastApplied = NO_VERSION_APPLIED;
  return {
    shouldApply(version: number): boolean {
      if (version < lastApplied) return false;
      lastApplied = version;
      return true;
    },
    bump(): void {
      lastApplied += 1;
    },
    reset(): void {
      lastApplied = NO_VERSION_APPLIED;
    },
  };
}
