/**
 * Tab shortcuts (#6161): switch to tab 1–9 and reopen a closed tab. The
 * terminal keeps program keys (decision 2026-10-15), so each needs a modifier a
 * terminal program does not use: Cmd on macOS, Alt+Shift elsewhere (Ctrl+Alt
 * is AltGr on many layouts, where it types characters).
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_BINDINGS, isShellReservedKey } from "./keybindings";
import type { KeyCombo } from "@/types/keybindings";

const binding = (action: string) => DEFAULT_BINDINGS.find((b) => b.action === action);
const single = (combo: KeyCombo | KeyCombo[] | null | undefined) =>
  (Array.isArray(combo) ? combo[0] : combo) ?? null;
const same = (a: KeyCombo, b: KeyCombo) =>
  a.key.toLowerCase() === b.key.toLowerCase() &&
  !!a.ctrl === !!b.ctrl &&
  !!a.shift === !!b.shift &&
  !!a.alt === !!b.alt &&
  !!a.meta === !!b.meta;

describe("tab shortcuts (#6161)", () => {
  it("switches to tab 1–9 with Cmd+N on macOS and Alt+Shift+N elsewhere", () => {
    for (let n = 1; n <= 9; n++) {
      const b = binding(`switch-to-tab-${n}`);
      expect(b, String(n)).toBeDefined();
      expect(single(b!.macDefault)).toEqual({ key: String(n), meta: true });
      expect(single(b!.winLinuxDefault)).toEqual({ key: String(n), alt: true, shift: true });
    }
    expect(binding("switch-to-tab-9")!.label).toBe("Switch to the last tab");
  });

  it("reopens a closed tab with Ctrl+Cmd+T on macOS and Alt+Shift+T elsewhere", () => {
    const b = binding("reopen-closed-tab");
    expect(b?.label).toBe("Reopen closed tab");
    expect(single(b!.macDefault)).toEqual({ key: "t", meta: true, ctrl: true });
    expect(single(b!.winLinuxDefault)).toEqual({ key: "T", alt: true, shift: true });
  });

  it("takes no key a terminal program uses, and no other shortcut's key", () => {
    const actions = [
      "reopen-closed-tab",
      ...Array.from({ length: 9 }, (_, i) => `switch-to-tab-${i + 1}`),
    ];
    for (const action of actions) {
      for (const platform of ["macDefault", "winLinuxDefault"] as const) {
        const combo = single(binding(action)![platform])!;
        const event = {
          key: combo.key,
          code: /^\d$/.test(combo.key) ? `Digit${combo.key}` : `Key${combo.key.toUpperCase()}`,
          ctrlKey: !!combo.ctrl,
          shiftKey: !!combo.shift,
          altKey: !!combo.alt,
          metaKey: !!combo.meta,
        } as KeyboardEvent;
        expect(isShellReservedKey(event), `${action} ${platform}`).toBe(false);
        const others = DEFAULT_BINDINGS.filter((b) => b.action !== action)
          .map((b) => single(b[platform]))
          .filter((c): c is KeyCombo => c !== null);
        expect(
          others.some((other) => same(other, combo)),
          `${action} ${platform}`
        ).toBe(false);
      }
    }
  });
});
