/**
 * Client-generated identifiers for the projection substrate (#2149).
 *
 * Intent ids are ULIDs — lexicographically sortable, time-ordered, and
 * collision-resistant — per the design concept. Backed by the maintained
 * `ulid` package rather than a hand-rolled generator.
 */

import { ulid } from "ulid";

/** A fresh ULID for an {@link import("./types").Intent}'s `intentId`. */
export function newIntentId(): string {
  return ulid();
}

/**
 * A stable per-client identity for a transport instance. Used as the `clientId`
 * on intents and subscriptions (fan-out / audit identity, and the key for
 * client-scoped regions like `layout@<clientId>`).
 */
export function newClientId(): string {
  return `client-${ulid()}`;
}

/**
 * A collision-safe entity id, optionally carrying a short readable prefix
 * (e.g. `conn`, `folder`, `agent`). Backed by {@link ulid} — time-ordered,
 * lexicographically sortable, and collision-resistant — so two entities minted
 * in the same millisecond still get distinct ids. Prefer this over deriving an
 * id from a bare `Date.now()`, which collides on rapid/bulk creation and
 * silently overwrites the first entity on its store/React key.
 *
 * @param prefix optional readable prefix; when given the id is `<prefix>-<ulid>`.
 */
export function newId(prefix?: string): string {
  return prefix ? `${prefix}-${ulid()}` : ulid();
}
