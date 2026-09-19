/**
 * Tests for the keyboard-shortcut import/export helpers (PROD-055).
 *
 * Covers the versioned envelope serialise/parse round-trip through the real
 * keybindings service (export the current overrides, re-import, and confirm the
 * effective bindings are restored exactly), and rejection of malformed files
 * with clear errors that leave the existing overrides untouched.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  KEYBINDING_EXPORT_VERSION,
  serializeKeybindings,
  parseKeybindingEnvelope,
} from "./keybindingIo";
import {
  clearOverrides,
  setOverride,
  setOverrides,
  getOverrides,
  unbindAction,
} from "./keybindings";

describe("keybindingIo", () => {
  beforeEach(() => {
    clearOverrides();
  });

  it("serializes overrides into a versioned envelope", () => {
    const json = serializeKeybindings([{ action: "toggle-sidebar", key: "Ctrl+Shift+b" }]);
    const parsed = JSON.parse(json);
    expect(parsed.version).toBe(KEYBINDING_EXPORT_VERSION);
    expect(parsed.bindings).toEqual([{ action: "toggle-sidebar", key: "Ctrl+Shift+b" }]);
  });

  it("round-trips overrides losslessly through export then import", () => {
    // Seed a mix of a rebind, a chord, and an explicit unbind.
    setOverride("close-tab", { key: "q", ctrl: true });
    setOverride("toggle-sidebar", [
      { key: "k", ctrl: true },
      { key: "s", ctrl: true },
    ]);
    unbindAction("new-terminal");
    const before = getOverrides();
    expect(before.length).toBe(3);

    const json = serializeKeybindings(before);

    // Wipe local state to prove the import restores it, not residue.
    clearOverrides();
    expect(getOverrides()).toEqual([]);

    const restored = parseKeybindingEnvelope(json);
    setOverrides(restored);

    expect(getOverrides()).toEqual(before);
  });

  it("rejects invalid JSON without touching existing overrides", () => {
    setOverride("close-tab", { key: "q", ctrl: true });
    const before = getOverrides();

    expect(() => parseKeybindingEnvelope("{not json")).toThrow(/not valid JSON/);
    // The parser throws before any apply, so a caller that guards on it never
    // mutates the current bindings.
    expect(getOverrides()).toEqual(before);
  });

  it("rejects an unsupported envelope version", () => {
    const json = JSON.stringify({ version: 999, bindings: [] });
    expect(() => parseKeybindingEnvelope(json)).toThrow(
      /Unsupported keyboard-shortcuts file version/
    );
  });

  it("rejects a missing bindings array", () => {
    const json = JSON.stringify({ version: KEYBINDING_EXPORT_VERSION });
    expect(() => parseKeybindingEnvelope(json)).toThrow(/missing "bindings" array/);
  });

  it("rejects an entry missing its action", () => {
    const json = JSON.stringify({
      version: KEYBINDING_EXPORT_VERSION,
      bindings: [{ key: "Ctrl+b" }],
    });
    expect(() => parseKeybindingEnvelope(json)).toThrow(/is missing an action/);
  });

  it("accepts an empty key as the serialized unbound sentinel", () => {
    const json = JSON.stringify({
      version: KEYBINDING_EXPORT_VERSION,
      bindings: [{ action: "new-terminal", key: "" }],
    });
    expect(parseKeybindingEnvelope(json)).toEqual([{ action: "new-terminal", key: "" }]);
  });
});
