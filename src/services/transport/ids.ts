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
