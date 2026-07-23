import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  serializeCombo,
  serializeBinding,
  parseCombo,
  parseBinding,
  eventMatchesCombo,
  findMatchingAction,
  isAppShortcut,
  getEffectiveCombo,
  setOverrides,
  clearOverrides,
  setOverride,
  checkConflict,
  getDefaultBindings,
  processKeyEvent,
  cancelChord,
  isChordPending,
  isShellReservedKey,
  isEventFromTerminal,
  DEFAULT_BINDINGS,
  unbindAction,
  isUnboundCombo,
  isActionUnbound,
  getOverrides,
  UNBOUND_COMBO,
} from "./keybindings";
import { KeyCombo } from "@/types/keybindings";

function makeKeyEvent(
  key: string,
  mods: { ctrl?: boolean; shift?: boolean; meta?: boolean; alt?: boolean } = {}
): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    metaKey: mods.meta ?? false,
    altKey: mods.alt ?? false,
  });
}

describe("serializeCombo / parseCombo round-trip", () => {
  const cases: [KeyCombo, string][] = [
    [{ key: "c", meta: true }, "Cmd+c"],
    [{ key: "C", ctrl: true, shift: true }, "Ctrl+Shift+C"],
    [{ key: "Tab", ctrl: true }, "Ctrl+Tab"],
    [{ key: "ArrowRight", ctrl: true, alt: true }, "Ctrl+Alt+Right"],
    [{ key: "b", ctrl: true }, "Ctrl+b"],
    [{ key: " " }, "Space"],
  ];

  it.each(cases)("serializes %o to %s", (combo, expected) => {
    expect(serializeCombo(combo)).toBe(expected);
  });

  it("round-trips a combo through serialize → parse", () => {
    const original: KeyCombo = { key: "C", ctrl: true, shift: true };
    const serialized = serializeCombo(original);
    const parsed = parseCombo(serialized);
    expect(parsed.ctrl).toBe(true);
    expect(parsed.shift).toBe(true);
    expect(parsed.key).toBe("C");
  });
});

describe("serializeBinding / parseBinding", () => {
  it("serializes a single combo", () => {
    const combo: KeyCombo = { key: "b", ctrl: true };
    expect(serializeBinding(combo)).toBe("Ctrl+b");
  });

  it("serializes a chord (array of combos)", () => {
    const chord: KeyCombo[] = [
      { key: "k", ctrl: true },
      { key: "s", ctrl: true },
    ];
    expect(serializeBinding(chord)).toBe("Ctrl+k Ctrl+s");
  });

  it("round-trips a chord through serialize → parse", () => {
    const chord: KeyCombo[] = [
      { key: "k", ctrl: true },
      { key: "s", ctrl: true },
    ];
    const serialized = serializeBinding(chord);
    const parsed = parseBinding(serialized);
    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed as KeyCombo[]).length).toBe(2);
  });
});

describe("eventMatchesCombo", () => {
  it("matches Ctrl+B", () => {
    const combo: KeyCombo = { key: "b", ctrl: true };
    const event = makeKeyEvent("b", { ctrl: true });
    expect(eventMatchesCombo(event, combo)).toBe(true);
  });

  it("does not match when modifier is wrong", () => {
    const combo: KeyCombo = { key: "b", ctrl: true };
    const event = makeKeyEvent("b", { meta: true });
    expect(eventMatchesCombo(event, combo)).toBe(false);
  });

  it("does not match when extra modifiers present", () => {
    const combo: KeyCombo = { key: "b", ctrl: true };
    const event = makeKeyEvent("b", { ctrl: true, shift: true });
    expect(eventMatchesCombo(event, combo)).toBe(false);
  });

  it("matches case-insensitively", () => {
    const combo: KeyCombo = { key: "C", ctrl: true, shift: true };
    const event = makeKeyEvent("C", { ctrl: true, shift: true });
    expect(eventMatchesCombo(event, combo)).toBe(true);
  });

  it("matches Shift+= (producing +) against = binding via shift-key equivalence", () => {
    const combo: KeyCombo = { key: "=", meta: true };
    const event = makeKeyEvent("+", { meta: true, shift: true });
    expect(eventMatchesCombo(event, combo)).toBe(true);
  });

  it("matches Shift+- (producing _) against - binding via shift-key equivalence", () => {
    const combo: KeyCombo = { key: "-", ctrl: true };
    const event = makeKeyEvent("_", { ctrl: true, shift: true });
    expect(eventMatchesCombo(event, combo)).toBe(true);
  });

  it("does not match shift-equivalent when other modifiers differ", () => {
    const combo: KeyCombo = { key: "=", meta: true };
    const event = makeKeyEvent("+", { ctrl: true, shift: true });
    expect(eventMatchesCombo(event, combo)).toBe(false);
  });
});

describe("findMatchingAction (Linux/Win context)", () => {
  // jsdom user agent = Linux

  beforeEach(() => {
    clearOverrides();
  });

  it("finds toggle-sidebar for Ctrl+Shift+B (relocated to avoid tmux prefix)", () => {
    const event = makeKeyEvent("B", { ctrl: true, shift: true });
    expect(findMatchingAction(event)).toBe("toggle-sidebar");
  });

  it("does not match toggle-sidebar for Ctrl+B (tmux prefix passes through)", () => {
    const event = makeKeyEvent("b", { ctrl: true });
    expect(findMatchingAction(event)).toBeNull();
  });

  it("finds close-tab for Ctrl+Shift+W (relocated to avoid readline delete-word)", () => {
    const event = makeKeyEvent("W", { ctrl: true, shift: true });
    expect(findMatchingAction(event)).toBe("close-tab");
  });

  it("does not match close-tab for Ctrl+W (readline delete-word passes through)", () => {
    const event = makeKeyEvent("w", { ctrl: true });
    expect(findMatchingAction(event)).toBeNull();
  });

  it("finds copy for Ctrl+Shift+C", () => {
    const event = makeKeyEvent("C", { ctrl: true, shift: true });
    expect(findMatchingAction(event)).toBe("copy");
  });

  it("finds split-right for Alt+Shift+\\ (relocated off Ctrl+\\ SIGQUIT)", () => {
    const event = makeKeyEvent("\\", { alt: true, shift: true });
    expect(findMatchingAction(event)).toBe("split-right");
  });

  it("does not match split-right for Ctrl+\\ (SIGQUIT passes through)", () => {
    const event = makeKeyEvent("\\", { ctrl: true });
    expect(findMatchingAction(event)).toBeNull();
  });

  it("finds split-down for Alt+Shift+-", () => {
    const event = makeKeyEvent("-", { alt: true, shift: true });
    expect(findMatchingAction(event)).toBe("split-down");
  });

  it("finds paste for Ctrl+Shift+V", () => {
    const event = makeKeyEvent("V", { ctrl: true, shift: true });
    expect(findMatchingAction(event)).toBe("paste");
  });

  it("finds zoom-in for Ctrl+= (base key)", () => {
    const event = makeKeyEvent("=", { ctrl: true });
    expect(findMatchingAction(event)).toBe("zoom-in");
  });

  it("finds zoom-in for Ctrl+Shift+= (producing +) via shift-key equivalence", () => {
    const event = makeKeyEvent("+", { ctrl: true, shift: true });
    expect(findMatchingAction(event)).toBe("zoom-in");
  });

  it("finds show-shortcuts for F1 (relocated off Ctrl+K Ctrl+S chord)", () => {
    const event = makeKeyEvent("F1");
    expect(findMatchingAction(event)).toBe("show-shortcuts");
  });

  it("finds focus-up for Alt+Shift+ArrowUp (relocated off Ctrl+Alt+Arrow)", () => {
    const event = makeKeyEvent("ArrowUp", { alt: true, shift: true });
    expect(findMatchingAction(event)).toBe("focus-up");
  });

  it("does not match focus-up for Ctrl+Alt+ArrowUp (workspace switch passes through)", () => {
    const event = makeKeyEvent("ArrowUp", { ctrl: true, alt: true });
    expect(findMatchingAction(event)).toBeNull();
  });

  it("finds close-tab-group for Ctrl+Shift+Q (relocated to free Ctrl+Shift+W for Close Tab)", () => {
    const event = makeKeyEvent("Q", { ctrl: true, shift: true });
    expect(findMatchingAction(event)).toBe("close-tab-group");
  });

  it("returns null for unrecognized keys", () => {
    const event = makeKeyEvent("z", { ctrl: true });
    expect(findMatchingAction(event)).toBeNull();
  });
});

describe("isAppShortcut", () => {
  it("returns true for known shortcuts", () => {
    expect(isAppShortcut(makeKeyEvent("B", { ctrl: true, shift: true }))).toBe(true);
  });

  it("returns false for unknown keys", () => {
    expect(isAppShortcut(makeKeyEvent("z"))).toBe(false);
  });
});

describe("overrides", () => {
  beforeEach(() => {
    clearOverrides();
  });

  it("setOverrides replaces bindings", () => {
    setOverrides([{ action: "toggle-sidebar", key: "Ctrl+Shift+b" }]);
    const combo = getEffectiveCombo("toggle-sidebar");
    expect(combo).toBeDefined();
    expect((combo as KeyCombo).shift).toBe(true);
  });

  it("setOverride for a single action", () => {
    setOverride("close-tab", { key: "q", ctrl: true });
    const combo = getEffectiveCombo("close-tab") as KeyCombo;
    expect(combo.key).toBe("q");
    expect(combo.ctrl).toBe(true);
  });

  it("setOverride with null removes override", () => {
    setOverride("close-tab", { key: "q", ctrl: true });
    setOverride("close-tab", null);
    const combo = getEffectiveCombo("close-tab") as KeyCombo;
    // Should be back to default (Ctrl+Shift+W on Linux)
    expect(combo.key).toBe("W");
    expect(combo.ctrl).toBe(true);
    expect(combo.shift).toBe(true);
  });

  it("clearOverrides resets all", () => {
    // Override to a binding distinct from the new default (which is Ctrl+Shift+B).
    setOverrides([{ action: "toggle-sidebar", key: "Ctrl+Alt+b" }]);
    const overridden = getEffectiveCombo("toggle-sidebar") as KeyCombo;
    expect(overridden.alt).toBe(true);

    clearOverrides();
    const restored = getEffectiveCombo("toggle-sidebar") as KeyCombo;
    expect(restored.alt).toBeUndefined();
    expect(restored.ctrl).toBe(true);
    expect(restored.shift).toBe(true);
    expect(restored.key).toBe("B");
  });
});

describe("unbind", () => {
  beforeEach(() => {
    clearOverrides();
  });

  it("isUnboundCombo recognizes empty combos and null", () => {
    expect(isUnboundCombo(UNBOUND_COMBO)).toBe(true);
    expect(isUnboundCombo({ key: "" })).toBe(true);
    expect(isUnboundCombo([])).toBe(true);
    expect(isUnboundCombo(null)).toBe(false);
    expect(isUnboundCombo({ key: "W", ctrl: true })).toBe(false);
  });

  it("unbindAction clears the binding so the action no longer fires on its former keys", () => {
    // close-tab defaults to Ctrl+Shift+W on Linux/Win.
    expect(findMatchingAction(makeKeyEvent("W", { ctrl: true, shift: true }))).toBe("close-tab");

    unbindAction("close-tab");

    expect(isActionUnbound("close-tab")).toBe(true);
    expect(findMatchingAction(makeKeyEvent("W", { ctrl: true, shift: true }))).toBeNull();
    expect(processKeyEvent(makeKeyEvent("W", { ctrl: true, shift: true }))).toBeNull();
  });

  it("an unbound action does NOT fall back to its platform default", () => {
    unbindAction("toggle-sidebar");
    const combo = getEffectiveCombo("toggle-sidebar");
    expect(isUnboundCombo(combo)).toBe(true);
    // Would be Ctrl+Shift+B if it had fallen back to the default.
    expect(findMatchingAction(makeKeyEvent("B", { ctrl: true, shift: true }))).toBeNull();
  });

  it("unbound state persists through serialization round-trip", () => {
    unbindAction("copy");
    const entries = getOverrides();
    const copyEntry = entries.find((e) => e.action === "copy");
    expect(copyEntry).toBeDefined();
    expect(copyEntry?.key).toBe("");

    // Simulate reload from persisted settings.
    clearOverrides();
    expect(isActionUnbound("copy")).toBe(false);
    setOverrides(entries);
    expect(isActionUnbound("copy")).toBe(true);
    expect(findMatchingAction(makeKeyEvent("C", { ctrl: true, shift: true }))).toBeNull();
  });

  it("reset-to-default restores an unbound action", () => {
    unbindAction("close-tab");
    expect(isActionUnbound("close-tab")).toBe(true);

    setOverride("close-tab", null);
    expect(isActionUnbound("close-tab")).toBe(false);
    expect(findMatchingAction(makeKeyEvent("W", { ctrl: true, shift: true }))).toBe("close-tab");
  });

  it("an unbound action is not reported as a conflict for a new binding", () => {
    unbindAction("close-tab");
    // Binding another action to close-tab's former keys must not conflict.
    expect(checkConflict({ key: "W", ctrl: true, shift: true }, "toggle-sidebar")).toBeNull();
  });
});

describe("checkConflict", () => {
  beforeEach(() => {
    clearOverrides();
  });

  it("detects conflict with existing binding", () => {
    // Ctrl+Shift+W is used by close-tab
    const conflict = checkConflict({ key: "W", ctrl: true, shift: true }, "toggle-sidebar");
    expect(conflict).toBe("close-tab");
  });

  it("excludes the specified action from conflict check", () => {
    const conflict = checkConflict({ key: "W", ctrl: true, shift: true }, "close-tab");
    expect(conflict).toBeNull();
  });

  it("returns null when no conflict", () => {
    const conflict = checkConflict({ key: "z", ctrl: true, shift: true });
    expect(conflict).toBeNull();
  });
});

describe("getDefaultBindings", () => {
  it("returns all default bindings", () => {
    const bindings = getDefaultBindings();
    expect(bindings.length).toBe(DEFAULT_BINDINGS.length);
    expect(bindings.length).toBeGreaterThan(10);
  });

  it("every binding has required fields", () => {
    for (const b of getDefaultBindings()) {
      expect(b.action).toBeTruthy();
      expect(b.label).toBeTruthy();
      expect(b.category).toBeTruthy();
      expect(b.macDefault).toBeDefined();
      expect(b.winLinuxDefault).toBeDefined();
    }
  });

  it("has directional focus bindings", () => {
    const actions = DEFAULT_BINDINGS.map((b) => b.action);
    expect(actions).toContain("focus-up");
    expect(actions).toContain("focus-down");
    expect(actions).toContain("focus-left");
    expect(actions).toContain("focus-right");
  });

  it("has split-right and split-down bindings", () => {
    const actions = DEFAULT_BINDINGS.map((b) => b.action);
    expect(actions).toContain("split-right");
    expect(actions).toContain("split-down");
  });

  it("split-down is distinct from split-right on every platform", () => {
    const binding = DEFAULT_BINDINGS.find((b) => b.action === "split-down");
    expect(binding).toBeDefined();
    const macCombo = binding!.macDefault as KeyCombo;
    expect(macCombo.meta).toBe(true);
    expect(macCombo.shift).toBe(true);
    expect(macCombo.key).toBe("\\");
    // Win/Linux: Alt+Shift+- avoids the SIGQUIT-firing Ctrl+\ family entirely.
    const winCombo = binding!.winLinuxDefault as KeyCombo;
    expect(winCombo.ctrl).toBeFalsy();
    expect(winCombo.alt).toBe(true);
    expect(winCombo.shift).toBe(true);
    expect(winCombo.key).toBe("-");
  });

  it("does not bind any Win/Linux default to a shell-reserved combo", () => {
    // Defaults must not collide with readline / tmux / vim / SSH-to-remote keys.
    // (Custom user overrides are protected separately by pass-through.)
    for (const binding of DEFAULT_BINDINGS) {
      const combo = binding.winLinuxDefault;
      // Actions that ship unbound (null default) cannot collide with anything.
      if (!combo) continue;
      const single = Array.isArray(combo) ? combo[0] : combo;
      // Simulate the modifier state that a key event would carry for this combo.
      const fakeEvent = {
        key: single.key,
        ctrlKey: !!single.ctrl,
        shiftKey: !!single.shift,
        altKey: !!single.alt,
        metaKey: !!single.meta,
      } as KeyboardEvent;
      expect(
        isShellReservedKey(fakeEvent),
        `${binding.action} default ${serializeBinding(combo)} collides with a shell-reserved key`
      ).toBe(false);
    }
  });

  it("does not have focus-next-panel or focus-prev-panel", () => {
    const actions = DEFAULT_BINDINGS.map((b) => b.action);
    expect(actions).not.toContain("focus-next-panel");
    expect(actions).not.toContain("focus-prev-panel");
  });

  it("clear-terminal macOS binding uses Shift to avoid chord conflict", () => {
    const binding = DEFAULT_BINDINGS.find((b) => b.action === "clear-terminal");
    expect(binding).toBeDefined();
    const macCombo = binding!.macDefault as KeyCombo;
    expect(macCombo.shift).toBe(true);
    expect(macCombo.meta).toBe(true);
  });
});

describe("getEffectiveCombo (macOS context)", () => {
  let originalAgent: PropertyDescriptor | undefined;

  beforeEach(() => {
    clearOverrides();
    originalAgent = Object.getOwnPropertyDescriptor(navigator, "userAgent");
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      configurable: true,
    });
  });

  afterEach(() => {
    if (originalAgent) {
      Object.defineProperty(navigator, "userAgent", originalAgent);
    } else {
      Object.defineProperty(navigator, "userAgent", {
        value: "Mozilla/5.0 (jsdom)",
        configurable: true,
      });
    }
  });

  it("returns macDefault on macOS", () => {
    const combo = getEffectiveCombo("toggle-sidebar") as KeyCombo;
    expect(combo.meta).toBe(true);
    expect(combo.ctrl).toBeUndefined();
  });

  it("returns null for unknown action", () => {
    expect(getEffectiveCombo("nonexistent")).toBeNull();
  });
});

describe("processKeyEvent (chord support, macOS context)", () => {
  // The Cmd+K Cmd+S chord for "Keyboard Shortcuts" is retained on macOS where
  // Cmd does not collide with shell readline. Win/Linux uses a non-chord F1.
  let originalAgent: PropertyDescriptor | undefined;

  beforeEach(() => {
    clearOverrides();
    cancelChord();
    vi.useFakeTimers();
    originalAgent = Object.getOwnPropertyDescriptor(navigator, "userAgent");
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      configurable: true,
    });
  });

  afterEach(() => {
    cancelChord();
    vi.useRealTimers();
    if (originalAgent) {
      Object.defineProperty(navigator, "userAgent", originalAgent);
    } else {
      Object.defineProperty(navigator, "userAgent", {
        value: "Mozilla/5.0 (jsdom)",
        configurable: true,
      });
    }
  });

  it("returns single-combo action for non-chord bindings", () => {
    const event = makeKeyEvent("b", { meta: true });
    expect(processKeyEvent(event)).toBe("toggle-sidebar");
  });

  it("returns chord-pending on first key of a chord", () => {
    const event = makeKeyEvent("k", { meta: true });
    expect(processKeyEvent(event)).toBe("chord-pending");
    expect(isChordPending()).toBe(true);
  });

  it("completes chord on second key", () => {
    const first = makeKeyEvent("k", { meta: true });
    processKeyEvent(first);

    const second = makeKeyEvent("s", { meta: true });
    expect(processKeyEvent(second)).toBe("show-shortcuts");
    expect(isChordPending()).toBe(false);
  });

  it("cancels chord on wrong second key", () => {
    const first = makeKeyEvent("k", { meta: true });
    processKeyEvent(first);

    // Wrong second key — should cancel chord and try single-combo match
    const second = makeKeyEvent("b", { meta: true });
    const result = processKeyEvent(second);
    expect(result).toBe("toggle-sidebar"); // Falls through to single-combo match
    expect(isChordPending()).toBe(false);
  });

  it("cancels chord after timeout", () => {
    const first = makeKeyEvent("k", { meta: true });
    processKeyEvent(first);
    expect(isChordPending()).toBe(true);

    vi.advanceTimersByTime(1500);
    expect(isChordPending()).toBe(false);
  });

  it("cancelChord clears pending state", () => {
    const first = makeKeyEvent("k", { meta: true });
    processKeyEvent(first);
    expect(isChordPending()).toBe(true);

    cancelChord();
    expect(isChordPending()).toBe(false);
  });
});

describe("isShellReservedKey", () => {
  it("matches Ctrl+letter combinations (readline/emacs/tmux range)", () => {
    for (const letter of ["a", "b", "c", "k", "l", "w", "z"]) {
      expect(isShellReservedKey(makeKeyEvent(letter, { ctrl: true }))).toBe(true);
    }
  });

  it("matches Ctrl+\\ (SIGQUIT), Ctrl+[ (Esc), Ctrl+] (telnet escape)", () => {
    expect(isShellReservedKey(makeKeyEvent("\\", { ctrl: true }))).toBe(true);
    expect(isShellReservedKey(makeKeyEvent("[", { ctrl: true }))).toBe(true);
    expect(isShellReservedKey(makeKeyEvent("]", { ctrl: true }))).toBe(true);
  });

  it("matches Alt+letter combinations (readline word-motion)", () => {
    expect(isShellReservedKey(makeKeyEvent("b", { alt: true }))).toBe(true);
    expect(isShellReservedKey(makeKeyEvent("f", { alt: true }))).toBe(true);
  });

  it("does not match Ctrl+Shift+letter (those are app/terminal-emulator shortcuts)", () => {
    expect(isShellReservedKey(makeKeyEvent("W", { ctrl: true, shift: true }))).toBe(false);
    expect(isShellReservedKey(makeKeyEvent("C", { ctrl: true, shift: true }))).toBe(false);
  });

  it("does not match Alt+Shift+letter or Alt+Shift+key", () => {
    expect(isShellReservedKey(makeKeyEvent("\\", { alt: true, shift: true }))).toBe(false);
    expect(isShellReservedKey(makeKeyEvent("-", { alt: true, shift: true }))).toBe(false);
    expect(isShellReservedKey(makeKeyEvent("ArrowUp", { alt: true, shift: true }))).toBe(false);
  });

  it("does not match Cmd-based combos (macOS shortcuts never collide with shell)", () => {
    expect(isShellReservedKey(makeKeyEvent("w", { meta: true }))).toBe(false);
    expect(isShellReservedKey(makeKeyEvent("b", { meta: true }))).toBe(false);
  });

  it("does not match plain letters or function keys", () => {
    expect(isShellReservedKey(makeKeyEvent("a"))).toBe(false);
    expect(isShellReservedKey(makeKeyEvent("F1"))).toBe(false);
  });

  it("does not match Ctrl+Alt (modifier doubled, used by app focus shortcuts elsewhere)", () => {
    expect(isShellReservedKey(makeKeyEvent("ArrowUp", { ctrl: true, alt: true }))).toBe(false);
  });
});

describe("isEventFromTerminal", () => {
  it("returns true when the event target is inside an .xterm element", () => {
    const xtermRoot = document.createElement("div");
    xtermRoot.className = "xterm";
    const inner = document.createElement("textarea");
    xtermRoot.appendChild(inner);
    document.body.appendChild(xtermRoot);

    const event = new KeyboardEvent("keydown", { key: "w" });
    Object.defineProperty(event, "target", { value: inner, configurable: true });
    expect(isEventFromTerminal(event)).toBe(true);

    document.body.removeChild(xtermRoot);
  });

  it("returns false when the event target is outside any .xterm element", () => {
    const outside = document.createElement("input");
    document.body.appendChild(outside);

    const event = new KeyboardEvent("keydown", { key: "w" });
    Object.defineProperty(event, "target", { value: outside, configurable: true });
    expect(isEventFromTerminal(event)).toBe(false);

    document.body.removeChild(outside);
  });
});
