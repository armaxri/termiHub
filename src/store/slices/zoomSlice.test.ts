import { describe, it, expect, beforeEach } from "vitest";
import { create, type StateCreator } from "zustand";

import { createZoomSlice, type ZoomSlice } from "./zoomSlice";

// Drive the slice directly against a standalone zustand store: the slice is a
// pure runtime-only reducer with no `@/services` deps, so the real `set`/`get`
// semantics are all it needs. The cast re-types the AppState-scoped creator to
// the isolated slice shape (its `get()` only ever reads its own state here).
const makeStore = () => create<ZoomSlice>()(createZoomSlice as unknown as StateCreator<ZoomSlice>);

describe("zoomSlice", () => {
  let store: ReturnType<typeof makeStore>;

  beforeEach(() => {
    store = makeStore();
  });

  it("starts at 1.0", () => {
    expect(store.getState().zoomLevel).toBe(1.0);
  });

  it("zoomIn steps up ~10% (rounded to 2dp)", () => {
    store.getState().zoomIn();
    expect(store.getState().zoomLevel).toBe(1.1);
    store.getState().zoomIn();
    expect(store.getState().zoomLevel).toBe(1.21);
  });

  it("zoomIn caps at 3.0 (Math.min upper branch)", () => {
    for (let i = 0; i < 50; i++) store.getState().zoomIn();
    expect(store.getState().zoomLevel).toBe(3.0);
    // A further zoomIn stays clamped, not exceeding the cap.
    store.getState().zoomIn();
    expect(store.getState().zoomLevel).toBe(3.0);
  });

  it("zoomOut steps down ~10% (rounded to 2dp)", () => {
    store.getState().zoomOut();
    expect(store.getState().zoomLevel).toBe(0.91);
  });

  it("zoomOut floors at 0.5 (Math.max lower branch)", () => {
    for (let i = 0; i < 50; i++) store.getState().zoomOut();
    expect(store.getState().zoomLevel).toBe(0.5);
    store.getState().zoomOut();
    expect(store.getState().zoomLevel).toBe(0.5);
  });

  it("zoomReset returns to 1.0 from either direction", () => {
    store.getState().zoomIn();
    store.getState().zoomReset();
    expect(store.getState().zoomLevel).toBe(1.0);
    store.getState().zoomOut();
    store.getState().zoomReset();
    expect(store.getState().zoomLevel).toBe(1.0);
  });
});
