/**
 * Tests for the command palette's command registry (#1484).
 *
 * The registry is sourced from the keybinding actions so labels and
 * accelerators have a single source of truth; only actions with a runner are
 * surfaced, and running a command invokes the matching store action.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildCommands } from "./commands";
import { getActionAccelerator, clearOverrides } from "./keybindings";
import { useAppStore } from "@/store/appStore";

describe("buildCommands", () => {
  beforeEach(() => {
    clearOverrides();
    useAppStore.setState({ ...useAppStore.getInitialState() });
  });

  it("sources label and accelerator from the keybinding action", () => {
    const commands = buildCommands();
    const newTerminal = commands.find((c) => c.id === "new-terminal");
    expect(newTerminal).toBeDefined();
    expect(newTerminal!.label).toBe("New Terminal");
    // Accelerator comes straight from the keybinding service — no duplication.
    expect(newTerminal!.accelerator).toBe(getActionAccelerator("new-terminal"));
  });

  it("only surfaces actions that have a runner", () => {
    const ids = buildCommands().map((c) => c.id);
    // Runnable, store-only commands are present…
    expect(ids).toContain("toggle-sidebar");
    expect(ids).toContain("open-settings");
    expect(ids).toContain("zoom-in");
    // …while the palette's own shortcut and context-bound actions are not.
    expect(ids).not.toContain("command-palette");
    expect(ids).not.toContain("close-tab");
    expect(ids).not.toContain("focus-up");
  });

  it("runs the matching store action", () => {
    const toggleSidebar = vi.fn();
    useAppStore.setState({ toggleSidebar });
    const cmd = buildCommands().find((c) => c.id === "toggle-sidebar");
    cmd!.run();
    expect(toggleSidebar).toHaveBeenCalledOnce();
  });
});
