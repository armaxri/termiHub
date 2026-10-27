/**
 * New-connection defaults (#5042): the command-mark shell hook is opt-in.
 *
 * The connection schemas default `shellIntegration` off, but the editor used to
 * override that with the app setting `defaultShellIntegration ?? true`, so every
 * new local / SSH / WSL connection saved with the hook on and typed it into the
 * shell. Nothing may be typed into the user's shell unless they opt in.
 */
import { describe, it, expect } from "vitest";
import type { ConnectionTypeInfo } from "@/services/api";
import { buildTypeDefaults } from "./connectionTypeDefaults";

function typeWithHook(typeId: string): ConnectionTypeInfo {
  return {
    typeId,
    displayName: typeId,
    icon: typeId,
    schema: {
      groups: [
        {
          key: "shell",
          label: "Shell",
          fields: [
            {
              key: "shellIntegration",
              label: "Command Marks (Shell Hook)",
              fieldType: { type: "boolean" },
              required: false,
              default: false,
            },
          ],
        },
      ],
    },
    capabilities: {
      monitoring: false,
      fileBrowser: true,
      resize: true,
      persistent: false,
    },
  } as ConnectionTypeInfo;
}

const HOOK_TYPES = ["local", "ssh", "wsl"];

describe("buildTypeDefaults — shell hook (#5042)", () => {
  it.each(HOOK_TYPES)("a new %s connection has the hook off with default settings", (typeId) => {
    expect(buildTypeDefaults(typeWithHook(typeId), {}).shellIntegration).toBe(false);
  });

  it.each(HOOK_TYPES)("a new %s connection has the hook off when the setting is off", (typeId) => {
    const defaults = buildTypeDefaults(typeWithHook(typeId), { defaultShellIntegration: false });
    expect(defaults.shellIntegration).toBe(false);
  });

  it.each(HOOK_TYPES)("an explicit opt-in in Settings pre-enables the hook for %s", (typeId) => {
    const defaults = buildTypeDefaults(typeWithHook(typeId), { defaultShellIntegration: true });
    expect(defaults.shellIntegration).toBe(true);
  });

  it("a type without the field gets no shellIntegration key", () => {
    const telnet = { ...typeWithHook("telnet"), schema: { groups: [] } } as ConnectionTypeInfo;
    expect(buildTypeDefaults(telnet, { defaultShellIntegration: true })).not.toHaveProperty(
      "shellIntegration"
    );
  });
});
