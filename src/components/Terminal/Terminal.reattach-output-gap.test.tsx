/**
 * No output is lost or shown twice between a scrollback replay and the live
 * subscription (#5990).
 *
 * A persistent re-attach repaints the session from a buffer snapshot, then
 * awaits a few backend calls before it subscribes to live output. The session
 * already accepts input in that window. Its answer used to be buffered by the
 * dispatcher and then thrown away together with the daemon's re-forwarded
 * replay: typing right after a re-attach showed nothing.
 *
 * The real dispatcher runs here. `setSessionLineEnding` is the barrier: while
 * it is held, the replay is on screen and nothing subscribed yet.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal } from "./Terminal";
import { TerminalPortalProvider } from "./TerminalRegistry";
import { useAppStore } from "@/store/appStore";
import { bytesToBase64, terminalDispatcher } from "@/services/events";
import { mockXtermInstances as xtermInstances } from "@/test/mockXterm";

vi.mock("@xterm/xterm", async () => (await import("@/test/mockXterm")).createMockXtermModule());
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = vi.fn();
    proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }));
    dispose = vi.fn();
  },
}));
vi.mock("@xterm/addon-unicode11", () => ({
  Unicode11Addon: class {
    dispose = vi.fn();
  },
}));
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    onDidChangeResults = vi.fn(() => ({ dispose: vi.fn() }));
    dispose = vi.fn();
  },
}));
vi.mock("@xterm/addon-serialize", () => ({
  SerializeAddon: class {
    serialize = vi.fn(() => "");
    dispose = vi.fn();
  },
}));
vi.mock("@/themes", () => ({
  getXtermTheme: vi.fn(() => ({})),
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

const mockNotifySessionStart = vi.hoisted(() => vi.fn());
vi.mock("@/plugins/sandbox/pluginSandboxHost", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/plugins/sandbox/pluginSandboxHost")>()),
  sandboxNotifySessionStart: mockNotifySessionStart,
}));

const handlers = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    handlers.set(name, handler);
    return Promise.resolve(() => {});
  }),
  emit: vi.fn().mockResolvedValue(undefined),
}));

const mockGetAgentSessionBuffer = vi.fn();
const mockReplayScrollback = vi.fn();
const mockSetLineEnding = vi.fn();
vi.mock("@/services/api", () => ({
  createTerminal: vi.fn().mockResolvedValue("fresh-session"),
  cancelConnecting: vi.fn().mockResolvedValue(undefined),
  sendInput: vi.fn().mockResolvedValue(undefined),
  setSessionLineEnding: (...a: unknown[]) => mockSetLineEnding(...a),
  resizeTerminal: vi.fn().mockResolvedValue(undefined),
  closeTerminal: vi.fn().mockResolvedValue(undefined),
  detachPersistentTab: vi.fn().mockResolvedValue(0),
  getAgentSessionBuffer: (...a: unknown[]) => mockGetAgentSessionBuffer(...a),
  replaySessionScrollback: (...a: unknown[]) => mockReplayScrollback(...a),
  sessionGetCapabilities: vi.fn().mockResolvedValue({}),
}));
vi.mock("@/services/keybindings", () => ({
  processKeyEvent: vi.fn(() => null),
  isAppShortcut: vi.fn(() => false),
  isChordPending: vi.fn(() => false),
  isShellReservedKey: vi.fn(() => false),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: vi.fn().mockResolvedValue(""),
}));

globalThis.ResizeObserver = class {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
} as unknown as typeof ResizeObserver;

const SID = "sess-1";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let container: HTMLDivElement;
let root: Root;
let releaseLineEnding: () => void;

/** The session's output stream so far: every event carries where it starts. */
let streamed = 0;
let epoch = 1;
function emitOutput(text: string | Uint8Array): void {
  const data = typeof text === "string" ? encoder.encode(text) : text;
  handlers.get("terminal-output")?.({
    payload: { session_id: SID, data: bytesToBase64(data), offset: streamed, epoch },
  });
  streamed += data.length;
}

/** The session ended; one under the same id starts a new stream. */
function endStream(): void {
  handlers.get("terminal-exit")?.({ payload: { session_id: SID, exit_code: null } });
  streamed = 0;
  epoch += 1;
}

/** A snapshot holding everything streamed up to now. */
function snapshot(text: string, endOffset = streamed) {
  return { data: encoder.encode(text), endOffset, epoch, coming: false };
}

beforeEach(async () => {
  useAppStore.setState(useAppStore.getInitialState());
  mockGetAgentSessionBuffer.mockReset();
  mockReplayScrollback.mockReset();
  mockReplayScrollback.mockResolvedValue({
    data: new Uint8Array(),
    endOffset: 0,
    epoch: 1,
    coming: false,
  });
  mockSetLineEnding.mockReset();
  const held = new Promise<void>((resolve) => {
    releaseLineEnding = resolve;
  });
  mockSetLineEnding.mockReturnValue(held);
  xtermInstances.length = 0;
  streamed = 0;
  epoch = 1;
  terminalDispatcher.destroy();
  handlers.clear();
  await terminalDispatcher.init();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  terminalDispatcher.destroy();
});

async function settle(): Promise<void> {
  await act(async () => {
    await wait(60);
  });
}

async function mountPersistent(): Promise<void> {
  const config = {
    type: "remote-session" as const,
    config: { agentId: "agent-1", sessionType: "shell" },
  };
  const tabId = useAppStore.getState().addTab("Persistent", "remote-session", config, {
    contentType: "terminal",
    sessionId: SID,
    persistentConnectionId: "agent-1:def-1",
  });
  act(() => {
    root.render(
      <TerminalPortalProvider>
        <Terminal
          tabId={tabId}
          config={config}
          isVisible={true}
          existingSessionId={SID}
          persistentConnectionId="agent-1:def-1"
        />
      </TerminalPortalProvider>
    );
  });
  await settle();
}

/** Everything the tab's xterm was given since its last reset, in order. */
function shown(): string {
  const xterm = xtermInstances[xtermInstances.length - 1];
  const resets = xterm.reset.mock.invocationCallOrder;
  const from = resets.length > 0 ? resets[resets.length - 1] : 0;
  return xterm.write.mock.calls
    .filter((_, i) => xterm.write.mock.invocationCallOrder[i] > from)
    .map((call) => (typeof call[0] === "string" ? call[0] : decoder.decode(call[0] as Uint8Array)))
    .join("");
}

describe("Terminal — persistent re-attach keeps the output of the hand-over (#5990)", () => {
  it("shows the answer to input typed before the tab subscribed, once", async () => {
    // The daemon re-forwards its buffer as live output on the attach.
    emitOutput("$ ");
    mockGetAgentSessionBuffer.mockResolvedValue(snapshot("$ "));
    await mountPersistent();
    expect(mockSetLineEnding).toHaveBeenCalledWith(SID, expect.anything());

    emitOutput("echo hi\r\nhi\r\n$ ");
    releaseLineEnding();
    await settle();

    expect(shown()).toBe("$ echo hi\r\nhi\r\n$ ");
  });

  it("drops a re-forwarded replay that arrives only after the tab subscribed", async () => {
    mockGetAgentSessionBuffer.mockResolvedValue(snapshot("$ ls\r\n$ ", 8));
    await mountPersistent();
    releaseLineEnding();
    await settle();

    emitOutput("$ ls\r\n$ ");
    emitOutput("pwd");
    await settle();

    expect(shown()).toBe("$ ls\r\n$ pwd");
  });

  it("splits a chunk the snapshot ends inside", async () => {
    mockGetAgentSessionBuffer.mockResolvedValue(snapshot("abc", 3));
    await mountPersistent();
    emitOutput("abcdef");
    releaseLineEnding();
    await settle();

    expect(shown()).toBe("abcdef");
  });

  it("keeps output equal to the end of the snapshot: the position decides, not the text", async () => {
    emitOutput("tick\r\n");
    mockGetAgentSessionBuffer.mockResolvedValue(snapshot("tick\r\n"));
    await mountPersistent();
    emitOutput("tick\r\n");
    releaseLineEnding();
    await settle();

    expect(shown()).toBe("tick\r\ntick\r\n");
  });

  it("shows the live re-forward when the snapshot could not be read", async () => {
    emitOutput("$ ");
    mockGetAgentSessionBuffer.mockRejectedValue(new Error("agent busy"));
    await mountPersistent();
    emitOutput("later");
    releaseLineEnding();
    await settle();

    expect(shown()).toBe("$ later");
  });

  it("keeps all the output of a hand-over larger than the dispatcher's cap", async () => {
    mockGetAgentSessionBuffer.mockResolvedValue(snapshot("", 0));
    await mountPersistent();
    const chunk = "x".repeat(100_000);
    for (let i = 0; i < 4; i += 1) emitOutput(`${i}${chunk}`);
    releaseLineEnding();
    await settle();

    expect(shown().length).toBe(4 * (chunk.length + 1));
  });

  it("collects the hand-over also while another tab of the session shows it", async () => {
    terminalDispatcher.subscribeOutput(SID, () => {});
    emitOutput("$ ");
    mockGetAgentSessionBuffer.mockResolvedValue(snapshot("$ "));
    await mountPersistent();
    emitOutput("ls\r\n");
    releaseLineEnding();
    await settle();

    expect(shown()).toBe("$ ls\r\n");
  });

  it("shows a new stream that began while the tab repainted the old one", async () => {
    // Another tab of the session ends it and starts it again under the same id.
    terminalDispatcher.subscribeOutput(SID, () => {});
    emitOutput("0123456789");
    mockGetAgentSessionBuffer.mockResolvedValue(snapshot("0123456789"));
    await mountPersistent();
    act(() => endStream());
    emitOutput("new");
    releaseLineEnding();
    await settle();

    expect(shown()).toContain("new");
  });

  it("drops output of a stream older than the repaint", async () => {
    const late = encoder.encode("late");
    epoch = 2;
    mockGetAgentSessionBuffer.mockResolvedValue(snapshot("$ ", 2));
    await mountPersistent();
    handlers.get("terminal-output")?.({
      payload: { session_id: SID, data: bytesToBase64(late), offset: 50, epoch: 1 },
    });
    releaseLineEnding();
    await settle();

    expect(shown()).toBe("$ ");
  });

  it("gives the hand-over back when the setup fails after the repaint", async () => {
    mockGetAgentSessionBuffer.mockResolvedValue(snapshot("", 0));
    await mountPersistent();
    emitOutput("kept ");
    mockNotifySessionStart.mockImplementationOnce(() => {
      throw new Error("setup failed");
    });
    releaseLineEnding();
    await settle();

    // Nothing collects any more: it all waits for the next subscriber.
    emitOutput("later");
    const next: string[] = [];
    terminalDispatcher.subscribeOutput(SID, (data) => next.push(decoder.decode(data)));
    expect(next.join("")).toBe("kept later");
  });

  it("leaves the hand-over to the next tab when this one is torn down first", async () => {
    mockGetAgentSessionBuffer.mockResolvedValue(snapshot("", 0));
    await mountPersistent();
    emitOutput("kept");
    act(() => root.render(null));
    await settle();

    const next: string[] = [];
    terminalDispatcher.subscribeOutput(SID, (data) => next.push(decoder.decode(data)));
    expect(next).toEqual(["kept"]);
  });

  it("shows a new stream of the same session id from its start", async () => {
    emitOutput("0123456789");
    mockGetAgentSessionBuffer.mockResolvedValue(snapshot("0123456789"));
    await mountPersistent();
    releaseLineEnding();
    await settle();

    act(() => endStream());
    emitOutput("new");
    await settle();

    expect(shown().endsWith("new")).toBe(true);
  });
});

describe("Terminal — a session moved to this window keeps its hand-over output (#5990)", () => {
  it("shows what came after the scrollback snapshot, once", async () => {
    emitOutput("$ make\r\n");
    mockReplayScrollback.mockResolvedValue(snapshot("$ make\r\n"));
    const config = { type: "local" as const, config: {} };
    const tabId = useAppStore.getState().addTab("Moved", "local", config, {
      contentType: "terminal",
      sessionId: SID,
    });
    act(() => {
      root.render(
        <TerminalPortalProvider>
          <Terminal
            tabId={tabId}
            config={config}
            isVisible={true}
            existingSessionId={SID}
            replayScrollbackOnAttach={true}
          />
        </TerminalPortalProvider>
      );
    });
    await settle();
    emitOutput("cc a.c\r\n");
    releaseLineEnding();
    await settle();

    expect(shown()).toBe("$ make\r\ncc a.c\r\n");
  });
});

describe("Terminal — a window that regains a session keeps the repaint's output (#5990)", () => {
  it("shows output that came while the repaint was read after it, once", async () => {
    mockGetAgentSessionBuffer.mockResolvedValue(snapshot("", 0));
    await mountPersistent();
    releaseLineEnding();
    await settle();
    emitOutput("one ");
    await settle();

    let answer: (value: ReturnType<typeof snapshot>) => void = () => {};
    mockReplayScrollback.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    act(() => useAppStore.getState().setSessionOwners({ [SID]: "win-1" }));
    act(() => useAppStore.getState().setSessionOwners({ [SID]: "main" }));
    emitOutput("two ");
    const repaint = snapshot("one two ");
    emitOutput("three");
    await act(async () => {
      answer(repaint);
      await wait(60);
    });

    expect(shown()).toBe("one two three");
  });

  /** Lose the session to another window and get it back. */
  function regain(): void {
    act(() => useAppStore.getState().setSessionOwners({ [SID]: "win-1" }));
    act(() => useAppStore.getState().setSessionOwners({ [SID]: "main" }));
  }

  /** A tab on screen, and repaints that are answered by hand. */
  async function mountWithHeldRepaints() {
    mockGetAgentSessionBuffer.mockResolvedValue(snapshot("", 0));
    await mountPersistent();
    releaseLineEnding();
    await settle();
    const answers: ((value: ReturnType<typeof snapshot>) => void)[] = [];
    mockReplayScrollback.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
    return answers;
  }

  it("writes output that waits for the repaint before the line that ends the session", async () => {
    const answers = await mountWithHeldRepaints();
    regain();
    emitOutput("last words");
    act(() => endStream());
    await settle();
    // The repaint of the ended stream comes too late to wipe the end line.
    await act(async () => {
      answers[0]({ data: encoder.encode("stale"), endOffset: 5, epoch: 1, coming: false });
      await wait(60);
    });

    const text = shown();
    expect(text.startsWith("last words")).toBe(true);
    expect(text).toMatch(/last words[^]*connection lost/i);
    expect(text).not.toContain("stale");
    expect(text.trimEnd().endsWith("last words")).toBe(false);
  });

  it("keeps the output between two repaints that overlap", async () => {
    const answers = await mountWithHeldRepaints();
    regain();
    emitOutput("one ");
    const first = snapshot("one ");
    regain();
    emitOutput("two ");
    const second = snapshot("one two ");
    await act(async () => {
      answers[0](first);
      await wait(30);
    });
    emitOutput("three");
    await settle();
    await act(async () => {
      answers[1](second);
      await wait(60);
    });

    expect(shown()).toBe("one two three");
  });

  it("shows output that was not painted yet when the window regained it once", async () => {
    const answers = await mountWithHeldRepaints();
    emitOutput("one ");
    regain();
    await act(async () => {
      answers[0](snapshot("one "));
      await wait(60);
    });

    expect(shown()).toBe("one ");
  });
});
