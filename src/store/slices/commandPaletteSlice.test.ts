import { describe, it, expect, beforeEach } from "vitest";
import { create, type StateCreator } from "zustand";

import { createCommandPaletteSlice, type CommandPaletteSlice } from "./commandPaletteSlice";

// Runtime-only overlay/palette flags; pure reducers, no `@/services`.
const makeStore = () =>
  create<CommandPaletteSlice>()(
    createCommandPaletteSlice as unknown as StateCreator<CommandPaletteSlice>
  );

describe("commandPaletteSlice", () => {
  let store: ReturnType<typeof makeStore>;

  beforeEach(() => {
    store = makeStore();
  });

  it("defaults every overlay to closed", () => {
    const s = store.getState();
    expect(s.shortcutsOverlayOpen).toBe(false);
    expect(s.commandPaletteOpen).toBe(false);
    expect(s.overlayView).toBeNull();
  });

  it("toggles the shortcuts overlay", () => {
    store.getState().setShortcutsOverlayOpen(true);
    expect(store.getState().shortcutsOverlayOpen).toBe(true);
    store.getState().setShortcutsOverlayOpen(false);
    expect(store.getState().shortcutsOverlayOpen).toBe(false);
  });

  it("toggles the command palette", () => {
    store.getState().setCommandPaletteOpen(true);
    expect(store.getState().commandPaletteOpen).toBe(true);
    store.getState().setCommandPaletteOpen(false);
    expect(store.getState().commandPaletteOpen).toBe(false);
  });

  it("opens each standalone overlay view and closes back to null", () => {
    store.getState().openOverlayView("updates");
    expect(store.getState().overlayView).toBe("updates");
    store.getState().openOverlayView("about");
    expect(store.getState().overlayView).toBe("about");
    store.getState().closeOverlayView();
    expect(store.getState().overlayView).toBeNull();
  });
});
