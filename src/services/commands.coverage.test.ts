/**
 * Coverage guard for the command palette (UX-028).
 *
 * `buildCommands` silently skips any keybinding action that has no runner, so a
 * newly-declared action can quietly never appear in the palette. This test makes
 * that gap loud: every declared action must either be surfaced by
 * `buildCommands()` or be listed in {@link PALETTE_EXCLUDED_ACTIONS} with a
 * documented reason. Adding an action without wiring a runner — or excluding it —
 * fails here instead of shipping an invisible command.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { buildCommands, PALETTE_EXCLUDED_ACTIONS } from "./commands";
import { getDefaultBindings, clearOverrides } from "./keybindings";
import { useAppStore } from "@/store/appStore";

describe("command palette action coverage", () => {
  beforeEach(() => {
    clearOverrides();
    useAppStore.setState({ ...useAppStore.getInitialState() });
  });

  it("surfaces every declared action except the documented exclusions", () => {
    const surfaced = new Set(buildCommands().map((c) => c.id));
    const missing = getDefaultBindings()
      .map((b) => b.action)
      .filter((action) => !surfaced.has(action) && !PALETTE_EXCLUDED_ACTIONS.has(action));
    expect(missing).toEqual([]);
  });

  it("keeps every excluded action genuinely runnerless (no stale exclusions)", () => {
    const surfaced = new Set(buildCommands().map((c) => c.id));
    for (const action of PALETTE_EXCLUDED_ACTIONS) {
      expect(surfaced.has(action)).toBe(false);
    }
  });
});
