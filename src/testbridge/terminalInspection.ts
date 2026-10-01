/**
 * Read a terminal's non-text state for the `inspectTerminal` bridge verb
 * (#4013): its OSC 133 command marks (#3415) and its inline-image store
 * (PROD-057). Both live in per-tab registries the terminal fills on mount.
 */
import { getInlineImagesController } from "@/components/Terminal/inlineImages";
import { getCommandMarkTracker } from "@/services/commandMarks";
import type { TerminalInspection } from "./protocol";

/**
 * The hidden state of the terminal mounted for `tabId`, or `undefined` when
 * neither a command-mark tracker nor an inline-images controller is registered
 * for it (no terminal).
 */
export function inspectTerminal(tabId: string): TerminalInspection | undefined {
  const tracker = getCommandMarkTracker(tabId);
  const images = getInlineImagesController(tabId);
  if (!tracker && !images) return undefined;
  return {
    commandMarks: tracker
      ? {
          commands: tracker
            .getCommands()
            .map((c) => ({ state: c.state, exitCode: c.exitCode ?? null })),
          lastCommandOutput: tracker.getLastCommandOutput(),
        }
      : null,
    inlineImages: images
      ? { active: images.isActive(), storageUsage: images.storageUsage() }
      : null,
  };
}
