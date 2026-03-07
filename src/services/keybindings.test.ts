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
  DEFAULT_BINDINGS,
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
});

describe("findMatchingAction (Linux/Win context)", () => {
  // jsdom user agent = Linux

  beforeEach(() => {
    clearOverrides();
  });

  it("finds toggle-sidebar for Ctrl+B", () => {
    const event = makeKeyEvent("b", { ctrl: true });
    expect(findMatchingAction(event)).toBe("toggle-sidebar");
  });

  it("finds close-tab for Ctrl+W", () => {
    const event = makeKeyEvent("w", { ctrl: true });
    expect(findMatchingAction(event)).toBe("close-tab");
  });

  it("finds copy for Ctrl+Shift+C", () => {
    const event = makeKeyEvent("C", { ctrl: true, shift: true });
    expect(findMatchingAction(event)).toBe("copy");
  });

  it("finds paste for Ctrl+Shift+V", () => {
    const event = makeKeyEvent("V", { ctrl: true, shift: true });
    expect(findMatchingAction(event)).toBe("paste");
  });

  it("returns null for unrecognized keys", () => {
    const event = makeKeyEvent("z", { ctrl: true });
    expect(findMatchingAction(event)).toBeNull();
  });

  it("skips chord bindings (show-shortcuts)", () => {
    // show-shortcuts has a chord default, should not match a single keypress
    const event = makeKeyEvent("k", { ctrl: true });
    // clear-terminal on macOS is Cmd+K, but on win/linux it's Ctrl+Shift+K
    // Ctrl+K alone should not match any single-combo binding
    expect(findMatchingAction(event)).toBeNull();
  });
});

describe("isAppShortcut", () => {
  it("returns true for known shortcuts", () => {
    expect(isAppShortcut(makeKeyEvent("b", { ctrl: true }))).toBe(true);
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
    // Should be back to default (Ctrl+W on Linux)
    expect(combo.key).toBe("w");
  });

  it("clearOverrides resets all", () => {
    setOverrides([{ action: "toggle-sidebar", key: "Ctrl+Shift+b" }]);
    clearOverrides();
    const combo = getEffectiveCombo("toggle-sidebar") as KeyCombo;
    expect(combo.shift).toBeUndefined();
  });
});

describe("checkConflict", () => {
  beforeEach(() => {
    clearOverrides();
  });

  it("detects conflict with existing binding", () => {
    // Ctrl+W is used by close-tab
    const conflict = checkConflict({ key: "w", ctrl: true }, "toggle-sidebar");
    expect(conflict).toBe("close-tab");
  });

  it("excludes the specified action from conflict check", () => {
    const conflict = checkConflict({ key: "w", ctrl: true }, "close-tab");
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

describe("processKeyEvent (chord support)", () => {
  beforeEach(() => {
    clearOverrides();
    cancelChord();
    vi.useFakeTimers();
  });

  afterEach(() => {
    cancelChord();
    vi.useRealTimers();
  });

  it("returns single-combo action for non-chord bindings", () => {
    const event = makeKeyEvent("b", { ctrl: true });
    expect(processKeyEvent(event)).toBe("toggle-sidebar");
  });

  it("returns chord-pending on first key of a chord", () => {
    // Ctrl+K is the first key of show-shortcuts chord on Win/Linux
    const event = makeKeyEvent("k", { ctrl: true });
    expect(processKeyEvent(event)).toBe("chord-pending");
    expect(isChordPending()).toBe(true);
  });

  it("completes chord on second key", () => {
    const first = makeKeyEvent("k", { ctrl: true });
    processKeyEvent(first);

    const second = makeKeyEvent("s", { ctrl: true });
    expect(processKeyEvent(second)).toBe("show-shortcuts");
    expect(isChordPending()).toBe(false);
  });

  it("cancels chord on wrong second key", () => {
    const first = makeKeyEvent("k", { ctrl: true });
    processKeyEvent(first);

    // Wrong second key — should cancel chord and try single-combo match
    const second = makeKeyEvent("b", { ctrl: true });
    const result = processKeyEvent(second);
    expect(result).toBe("toggle-sidebar"); // Falls through to single-combo match
    expect(isChordPending()).toBe(false);
  });

  it("cancels chord after timeout", () => {
    const first = makeKeyEvent("k", { ctrl: true });
    processKeyEvent(first);
    expect(isChordPending()).toBe(true);

    vi.advanceTimersByTime(1500);
    expect(isChordPending()).toBe(false);
  });

  it("cancelChord clears pending state", () => {
    const first = makeKeyEvent("k", { ctrl: true });
    processKeyEvent(first);
    expect(isChordPending()).toBe(true);

    cancelChord();
    expect(isChordPending()).toBe(false);
  });
});
