/**
 * Coverage guard for the command palette (UX-028).
 *
 * `buildCommands` silently skips any keybinding action that has no runner, so a
 * newly-declared action can quietly never appear in the palette. This test makes
 * that gap loud: every declared action must either be surfaced by
 * `buildCommands()` or be listed in `PALETTE_EXCLUDED_ACTIONS` below with a
 * documented reason. Adding an action without wiring a runner — or excluding it —
 * fails here instead of shipping an invisible command.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { buildCommands } from "./commands";
import { getDefaultBindings, clearOverrides, RELEASE_CHORD_ACTION } from "./keybindings";
import { useAppStore } from "@/store/appStore";

/**
 * Keybinding actions deliberately left out of the command palette, with the
 * reason each is excluded. Any *other* action lacking a runner is a genuine gap
 * (a surfaced shortcut the palette silently drops), so adding an action without
 * wiring a runner — or listing it here — fails this test.
 *
 * - `command-palette` — opens the palette itself; a self-referential entry is
 *   pointless inside the palette.
 * - `release-remote-desktop-keyboard` — the remote-desktop release chord
 *   (#4524) is read directly by the focused canvas; running it from the
 *   palette is meaningless because opening the palette already left the canvas.
 *
 * The clipboard actions (`copy` / `paste` / `select-all`) are surfaced through
 * `CONTEXT_COMMANDS`, which routes them to the focused terminal via the
 * terminal command bridge (PROD-054).
 */
const PALETTE_EXCLUDED_ACTIONS: ReadonlySet<string> = new Set([
  "command-palette",
  RELEASE_CHORD_ACTION,
]);

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
