import { describe, it, expect, afterEach } from "vitest";
import { getActionAccelerator, clearOverrides, setOverride } from "./keybindings";

/**
 * `getActionAccelerator` is the single source of truth for rendering an action's
 * accelerator inline (e.g. on Settings-menu rows), so it must reflect the same
 * effective binding — user override or platform default — that the shortcuts
 * overlay shows (#1353).
 */
describe("getActionAccelerator", () => {
  afterEach(() => {
    clearOverrides();
  });

  it("returns a serialized accelerator for a known single-combo action", () => {
    const accel = getActionAccelerator("open-settings");
    expect(accel).toBeTruthy();
    // "Open Settings" is bound to <mod>+, on every platform.
    expect(accel).toContain(",");
  });

  it("returns the chord form for the shortcuts action", () => {
    const accel = getActionAccelerator("show-shortcuts");
    expect(accel).toBeTruthy();
  });

  it("reflects a user override rather than the platform default", () => {
    setOverride("open-settings", { key: "P", ctrl: true, shift: true });
    expect(getActionAccelerator("open-settings")).toBe("Ctrl+Shift+P");
  });

  it("returns null for an unknown action", () => {
    expect(getActionAccelerator("does-not-exist")).toBeNull();
  });
});
