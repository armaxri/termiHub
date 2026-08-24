/**
 * Unit tests for {@link InMemoryTransport} (#2283 slice E1): the backend-less
 * transport that lets the layout region→appStore mirror run headlessly. The
 * contract that matters is that a {@link ProjectionClient} dispatching over it
 * *keeps* its optimistic fold (accepted-with-`produced`), so the effective view
 * reflects the dispatched intent synchronously without any backend.
 */
import { describe, it, expect } from "vitest";

import { InMemoryTransport } from "./InMemoryTransport";
import { ProjectionClient } from "./ProjectionClient";
import type { Intent } from "./types";

const REGION = "layout@client-1";

function intent(kind: string): Intent {
  return { intentId: `i-${Math.random()}`, kind, payload: {}, clientId: "client-1" };
}

describe("InMemoryTransport", () => {
  it("subscribe returns an empty baseline snapshot for the region", async () => {
    const t = new InMemoryTransport();
    const sub = await t.subscribe(REGION, () => {});
    expect(sub.snapshot).toEqual({ region: REGION, kind: "snapshot", version: 0, view: undefined });
  });

  it("dispatch acks accepted with a fresh produced version per subscribed region", async () => {
    const t = new InMemoryTransport();
    await t.subscribe(REGION, () => {});
    const ack1 = await t.dispatch(intent("layout.split"));
    const ack2 = await t.dispatch(intent("layout.split"));

    expect(ack1.status).toBe("accepted");
    expect(ack1.produced).toEqual([{ region: REGION, version: 1 }]);
    // Monotonic — so a client's confirm version keeps advancing.
    expect(ack2.produced).toEqual([{ region: REGION, version: 2 }]);
  });

  it("reports no produced region once unsubscribed (fold would roll back)", async () => {
    const t = new InMemoryTransport();
    const sub = await t.subscribe(REGION, () => {});
    sub.unsubscribe();
    const ack = await t.dispatch(intent("layout.split"));
    expect(ack.produced).toEqual([]);
  });

  it("resync resolves null (no backend stream, nothing to re-baseline)", async () => {
    const t = new InMemoryTransport();
    await t.subscribe(REGION, () => {});
    expect(await t.resync(REGION, 0)).toBeNull();
  });

  it("a ProjectionClient's optimistic fold persists over it (drives the mirror)", async () => {
    const client = new ProjectionClient(new InMemoryTransport(), REGION);
    await client.start();

    const view = { groups: [{ id: "g1" }], activeGroupId: "g1" };
    const ack = await client.dispatchOptimistic(intent("layout.split"), () => view);

    expect(ack.status).toBe("accepted");
    // The fold is retained (accepted-with-produced), so the effective view is the
    // optimistic one — exactly what the region→appStore mirror composes from.
    expect(client.state.view).toBe(view);
  });
});
