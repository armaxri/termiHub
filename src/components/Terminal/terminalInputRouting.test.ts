import { describe, it, expect, vi, beforeEach } from "vitest";

const keybindings = vi.hoisted(() => ({
  isShellReservedKey: vi.fn<(e: KeyboardEvent) => boolean>(() => false),
  isChordPending: vi.fn<() => boolean>(() => false),
  processKeyEvent: vi.fn<(e: KeyboardEvent) => string | null>(() => null),
  isAppShortcut: vi.fn<(e: KeyboardEvent) => boolean>(() => false),
}));

vi.mock("@/services/keybindings", () => keybindings);

import {
  parseOsc7Cwd,
  parseOsc9Cwd,
  routeTerminalKeyEvent,
  type TerminalKeyRoutingContext,
} from "./terminalInputRouting";

/** Keybinding-service state for one routing case. */
interface KeyState {
  shellReserved?: boolean;
  chordPending?: boolean;
  action?: string | null;
  appShortcut?: boolean;
}

/** One table row: inputs, expected return value and which callback must fire. */
interface RoutingCase {
  name: string;
  type?: string;
  key?: string;
  ctx?: Partial<
    Pick<TerminalKeyRoutingContext, "hasSession" | "isViewMode" | "passthroughEnabled">
  >;
  hasMarks?: boolean;
  keys?: KeyState;
  expected: boolean;
  calls?: Array<"showReconnectPrompt" | "copySelection" | "paste" | "selectAll">;
  preventDefault?: boolean;
}

function makeContext(
  overrides: RoutingCase["ctx"] = {},
  hasMarks = false
): TerminalKeyRoutingContext {
  return {
    hasSession: true,
    isViewMode: false,
    passthroughEnabled: true,
    hasCommandMarks: vi.fn(() => hasMarks),
    showReconnectPrompt: vi.fn(),
    copySelection: vi.fn(),
    paste: vi.fn(),
    selectAll: vi.fn(),
    ...overrides,
  };
}

const CALLBACKS = ["showReconnectPrompt", "copySelection", "paste", "selectAll"] as const;

const ROUTING_CASES: RoutingCase[] = [
  { name: "lets keyup events through untouched", type: "keyup", expected: true },
  {
    name: "ignores shortcuts on keyup even when one would match",
    type: "keyup",
    keys: { action: "paste", appShortcut: true },
    expected: true,
  },
  {
    name: "Enter in view mode without a session shows the reconnect prompt",
    key: "Enter",
    ctx: { hasSession: false, isViewMode: true },
    expected: false,
    calls: ["showReconnectPrompt"],
  },
  {
    name: "Enter with a live session reaches the PTY",
    key: "Enter",
    ctx: { hasSession: true, isViewMode: true },
    expected: true,
  },
  {
    name: "Enter without a session outside view mode reaches the PTY",
    key: "Enter",
    ctx: { hasSession: false, isViewMode: false },
    expected: true,
  },
  {
    name: "a shell-reserved key passes through before shortcut matching",
    keys: { shellReserved: true, action: "copy", appShortcut: true },
    expected: true,
  },
  {
    name: "a shell-reserved key is matched as a shortcut when passthrough is off",
    ctx: { passthroughEnabled: false },
    keys: { shellReserved: true, action: "copy" },
    expected: false,
    calls: ["copySelection"],
  },
  {
    name: "a pending chord blocks the key",
    keys: { chordPending: true, action: "paste" },
    expected: false,
  },
  {
    name: "starting a chord blocks the key",
    keys: { action: "chord-pending" },
    expected: false,
  },
  {
    name: "copy copies the selection",
    keys: { action: "copy" },
    expected: false,
    calls: ["copySelection"],
  },
  {
    name: "paste pastes and prevents the native paste",
    keys: { action: "paste" },
    expected: false,
    calls: ["paste"],
    preventDefault: true,
  },
  {
    name: "select-all selects the buffer",
    keys: { action: "select-all" },
    expected: false,
    calls: ["selectAll"],
  },
  {
    name: "prompt navigation falls through to the shell without OSC 133 marks",
    keys: { action: "jump-prev-prompt", appShortcut: true },
    hasMarks: false,
    expected: true,
  },
  {
    name: "prompt navigation is blocked from the PTY when marks exist",
    keys: { action: "jump-next-prompt", appShortcut: true },
    hasMarks: true,
    expected: false,
  },
  {
    name: "another app shortcut is blocked from the PTY",
    keys: { action: "new-terminal", appShortcut: true },
    expected: false,
  },
  { name: "an ordinary key reaches the PTY", keys: { action: null }, expected: true },
];

describe("routeTerminalKeyEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(ROUTING_CASES)("$name", (c) => {
    keybindings.isShellReservedKey.mockReturnValue(c.keys?.shellReserved ?? false);
    keybindings.isChordPending.mockReturnValue(c.keys?.chordPending ?? false);
    keybindings.processKeyEvent.mockReturnValue(c.keys?.action ?? null);
    keybindings.isAppShortcut.mockReturnValue(c.keys?.appShortcut ?? false);
    const ctx = makeContext(c.ctx, c.hasMarks);
    const event = new KeyboardEvent(c.type ?? "keydown", { key: c.key ?? "a", cancelable: true });

    expect(routeTerminalKeyEvent(event, ctx)).toBe(c.expected);

    for (const cb of CALLBACKS) {
      const expectedCalls = c.calls?.includes(cb) ? 1 : 0;
      expect(ctx[cb], cb).toHaveBeenCalledTimes(expectedCalls);
    }
    expect(event.defaultPrevented).toBe(c.preventDefault ?? false);
  });

  it("does not consult the keymap for keyup events", () => {
    routeTerminalKeyEvent(new KeyboardEvent("keyup", { key: "v" }), makeContext());
    expect(keybindings.processKeyEvent).not.toHaveBeenCalled();
  });

  it("only reads command marks for a prompt-navigation action", () => {
    keybindings.processKeyEvent.mockReturnValue("new-terminal");
    const ctx = makeContext();
    routeTerminalKeyEvent(new KeyboardEvent("keydown", { key: "t" }), ctx);
    expect(ctx.hasCommandMarks).not.toHaveBeenCalled();
  });
});

describe("parseOsc7Cwd", () => {
  it.each<[string, string, string | null]>([
    ["a POSIX path", "file:///home/user/foo", "/home/user/foo"],
    ["a path with a hostname", "file://myhost/home/user", "/home/user"],
    ["the root directory", "file:///", "/"],
    ["percent-escaped spaces", "file:///home/user/my%20dir", "/home/user/my dir"],
    ["percent-escaped UTF-8", "file:///home/%C3%BCser", "/home/üser"],
    ["an escaped percent sign", "file:///tmp/100%25", "/tmp/100%"],
    ["a Windows drive path", "file:///C:/Users/foo", "C:/Users/foo"],
    ["a lowercase Windows drive path", "file:///d:/work", "d:/work"],
    ["a drive-like segment that is not a drive root", "file:///C:", "/C:"],
    ["an http URI", "http://example.com/home/user", null],
    ["an https URI", "https://example.com/", null],
    ["a bare path", "/home/user", null],
    ["an empty payload", "", null],
    ["garbage", "not a uri", null],
    ["a malformed percent-escape", "file:///home/%E0%A4%A", null],
    ["a lone percent sign", "file:///home/100%", null],
  ])("%s", (_name, data, expected) => {
    expect(parseOsc7Cwd(data)).toBe(expected);
  });
});

describe("parseOsc9Cwd", () => {
  it.each<[string, string, string | null]>([
    ["a Windows path", "9;C:\\Users\\foo", "C:\\Users\\foo"],
    ["a path used verbatim (no decoding)", "9;C:\\my%20dir", "C:\\my%20dir"],
    ["a POSIX-style path", "9;/home/user", "/home/user"],
    ["an empty path", "9;", null],
    ["another OSC 9 sub-command", "4;1;50", null],
    ["a plain OSC 9 notification", "Build finished", null],
    ["a missing separator", "9", null],
    ["an empty payload", "", null],
  ])("%s", (_name, data, expected) => {
    expect(parseOsc9Cwd(data)).toBe(expected);
  });
});
