import { describe, it, expect } from "vitest";
import { toastHotkey } from "./toastHotkey";
import { DEFAULT_BINDINGS, serializeCombo } from "@/services/keybindings";
import type { KeyCombo } from "@/types/keybindings";

/** Turn a sonner hotkey array into the keybinding service's combo shape. */
function asCombo(hotkey: string[]): KeyCombo {
  const key = hotkey.find((k) => !k.endsWith("Key")) ?? "";
  return {
    key: key.replace(/^Key/, "").toLowerCase(),
    ctrl: hotkey.includes("ctrlKey"),
    shift: hotkey.includes("shiftKey"),
    alt: hotkey.includes("altKey"),
    meta: hotkey.includes("metaKey"),
  };
}

describe("toastHotkey (#5316)", () => {
  it.each([true, false])("is never sonner's default Alt+T (mac=%s)", (mac) => {
    expect(toastHotkey(mac)).not.toEqual(["altKey", "KeyT"]);
  });

  it.each([true, false])("is never empty, which would match every key (mac=%s)", (mac) => {
    expect(toastHotkey(mac).length).toBeGreaterThan(0);
  });

  it("uses Cmd+Option+T on macOS and Ctrl+Shift+F8 elsewhere", () => {
    expect(toastHotkey(true)).toEqual(["metaKey", "altKey", "KeyT"]);
    expect(toastHotkey(false)).toEqual(["ctrlKey", "shiftKey", "F8"]);
  });

  it.each([
    [true, "macDefault"],
    [false, "winLinuxDefault"],
  ] as const)("is bound by no app default (mac=%s)", (mac, field) => {
    const chord = serializeCombo(asCombo(toastHotkey(mac))).toLowerCase();
    for (const binding of DEFAULT_BINDINGS) {
      const combo = binding[field];
      if (!combo) continue;
      const first = Array.isArray(combo) ? combo[0] : combo;
      expect(serializeCombo(first).toLowerCase(), binding.action).not.toBe(chord);
    }
  });
});
