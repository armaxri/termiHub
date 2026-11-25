/**
 * A password prompt that has arrived counts before it is on the screen (#6070).
 *
 * Output waits in several places before xterm's buffer holds it: staged for the next
 * frame, held for the inline image addon, in a plugin's parser, collected while the
 * session is repainted, and in xterm's own write queue. "Continue" of a run that waits
 * for the user, and the recorder, must not judge the terminal without it.
 *
 * The real dispatcher, output flow, sandbox host and xterm parser run here.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Terminal as RealTerminal } from "@xterm/xterm";
import { Terminal } from "./Terminal";
import { TerminalPortalProvider } from "./TerminalRegistry";
import { useAppStore } from "@/store/appStore";
import { __emitSessionViewForTest, type ProjectedSessionLifecycle } from "@/store/sessionBridge";
import { bytesToBase64, terminalDispatcher } from "@/services/events";
import { promptOfTerminal } from "@/services/passwordPrompt";
import type { WaitForUserResult } from "@/services/workflowRunner";
import {
  __resetSandboxHost,
  __setSandboxWorkerFactory,
  loadPluginInSandbox,
} from "@/plugins/sandbox/pluginSandboxHost";
import type { HostToWorkerMessage, WorkerToHostMessage } from "@/plugins/sandbox/protocol";
import { FLOW_HIGH_WATERMARK } from "@/utils/terminalFlowControl";

/** The terminals the component made: a fake view on a real buffer and parser. */
const terminals = vi.hoisted(() => ({ list: [] as unknown[], block: false }));
vi.mock("@xterm/xterm", async (importOriginal) => {
  const { Terminal: Real } = await importOriginal<typeof import("@xterm/xterm")>();
  const { MockXTerm } = await import("@/test/mockXterm");
  class Engine extends MockXTerm {
    real = new Real({ cols: 80, rows: 24, allowProposedApi: true });
    /** Writes kept from the parser, as while it is busy. */
    queued: [string | Uint8Array, (() => void) | undefined][] = [];
    onData = vi.fn((listener: (data: string) => void) => {
      this.typed = listener;
      return { dispose: vi.fn() };
    });
    typed: (data: string) => void = () => {};
    constructor(options?: Record<string, unknown>) {
      super(options);
      this.buffer = this.real.buffer as never;
      this.write = vi.fn((data: string | Uint8Array, done?: () => void) => {
        if (terminals.block) this.queued.push([data, done]);
        else this.real.write(data, done);
      });
      this.writeln = vi.fn((data: string) => this.real.writeln(data));
      this.reset = vi.fn(() => this.real.reset());
      terminals.list.push(this);
    }
    registerMarker(offset?: number) {
      return this.real.registerMarker(offset);
    }
    /** The parser gets to what it was given. */
    unblock() {
      terminals.block = false;
      for (const [data, done] of this.queued.splice(0)) this.real.write(data, done);
    }
  }
  return { Terminal: Engine };
});
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
const imageHold = vi.hoisted(() => ({ on: false }));
vi.mock("./inlineImages", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  shouldHoldOutputForInlineImages: () => imageHold.on,
}));
const handlers = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    handlers.set(name, handler);
    return Promise.resolve(() => {});
  }),
  emit: vi.fn().mockResolvedValue(undefined),
}));
const mockReplay = vi.hoisted(() => vi.fn());
vi.mock("@/services/api", () => ({
  createTerminal: vi.fn().mockResolvedValue("fresh-session"),
  cancelConnecting: vi.fn().mockResolvedValue(undefined),
  sendInput: vi.fn().mockResolvedValue(undefined),
  setSessionLineEnding: vi.fn().mockResolvedValue(undefined),
  setTerminalOutputPaused: vi.fn().mockResolvedValue(undefined),
  resizeTerminal: vi.fn().mockResolvedValue(undefined),
  closeTerminal: vi.fn().mockResolvedValue(undefined),
  detachPersistentTab: vi.fn().mockResolvedValue(0),
  getAgentSessionBuffer: vi.fn().mockResolvedValue({
    data: new Uint8Array(),
    endOffset: 0,
    epoch: 1,
    coming: false,
  }),
  replaySessionScrollback: mockReplay,
  sessionGetCapabilities: vi.fn().mockResolvedValue({}),
}));
vi.mock("@/services/keybindings", () => ({
  processKeyEvent: vi.fn(() => null),
  isAppShortcut: vi.fn(() => false),
  isChordPending: vi.fn(() => false),
  isShellReservedKey: vi.fn(() => false),
}));

globalThis.ResizeObserver = class {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
} as unknown as typeof ResizeObserver;

const SID = "sess-1";
const PROMPT = "[sudo] password for arne: ";
const encoder = new TextEncoder();
const store = () => useAppStore.getState();

interface Engine {
  real: RealTerminal;
  typed: (data: string) => void;
  unblock: () => void;
  write: Mock;
}
const engine = () => terminals.list[terminals.list.length - 1] as Engine;

let container: HTMLDivElement;
let root: Root;
let tabId: string;
let streamed = 0;
let version = 9500;

/** The session prints `text`: it arrives now, on the screen it is later. */
function arrive(text: string | Uint8Array): void {
  const data = typeof text === "string" ? encoder.encode(text) : text;
  handlers.get("terminal-output")?.({
    payload: { session_id: SID, data: bytesToBase64(data), offset: streamed, epoch: 1 },
  });
  streamed += data.length;
}
const settle = (ms = 40) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
/** What the cursor's line shows. */
function line(): string {
  const { active } = engine().real.buffer;
  return (
    active
      .getLine(active.baseY + active.cursorY)
      ?.translateToString(true)
      .trimEnd() ?? ""
  );
}

beforeEach(async () => {
  useAppStore.setState(useAppStore.getInitialState());
  terminals.list.length = 0;
  terminals.block = false;
  imageHold.on = false;
  streamed = 0;
  mockReplay.mockReset();
  terminalDispatcher.destroy();
  handlers.clear();
  await terminalDispatcher.init();
  version += 1;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const config = {
    type: "remote-session" as const,
    config: { agentId: "agent-1", sessionType: "shell" },
  };
  tabId = store().addTab("Persistent", "remote-session", config, {
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
  await settle(60);
  act(() => {
    const session = { status: "connected" } as ProjectedSessionLifecycle;
    __emitSessionViewForTest({ sessions: { [tabId]: session } }, version);
  });
  arrive("$\r\n");
  await settle();
  expect(line()).toBe("");
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  terminalDispatcher.destroy();
  __resetSandboxHost();
  __setSandboxWorkerFactory(null);
  vi.useRealTimers();
});

/** A run that waits in the terminal. */
function startWait() {
  const state: { result?: WaitForUserResult } = {};
  void store()
    .waitForUser({
      runId: "run",
      tabId,
      sessionId: SID,
      tabTitle: "web",
      automationName: "Deploy",
    })
    .then((result) => (state.result = result));
  return state;
}
const pressContinue = () => act(() => store().continueAutomationWait("run"));
const wait = () => store().automationWaits[0];

/** A protocol parser that returns output unchanged, once told to. */
function slowParser(): () => void {
  type Listener = (event: { data: WorkerToHostMessage }) => void;
  let toHost: Listener = () => {};
  const asked: HostToWorkerMessage[] = [];
  const worker = {
    addEventListener: (type: string, listener: Listener) => {
      if (type === "message") toHost = listener;
    },
    postMessage: (message: HostToWorkerMessage) => asked.push(message),
    terminate: () => {},
  };
  __setSandboxWorkerFactory(() => worker as unknown as Worker);
  loadPluginInSandbox("parser", ["plugin://localhost/load/parser/index.js"]);
  toHost({ data: { t: "parsersActive", active: true } });
  return () => {
    for (const message of asked.splice(0)) {
      if (message.t !== "transform") continue;
      toHost({ data: { t: "transformResult", seq: message.seq, changed: false } });
    }
  };
}

const lose = () => act(() => store().setSessionOwners({ [SID]: "win-1" }));
const regain = () => act(() => store().setSessionOwners({ [SID]: "main" }));

describe("Continue sees a prompt that has arrived (#6070)", () => {
  /** Press Continue, let the output land, and expect the run to wait on. */
  async function heldBack(state: { result?: WaitForUserResult }) {
    await settle(60);
    expect(state.result).toBeUndefined();
    expect(wait()?.stillAsking).toBe(true);
    expect(line()).toBe(PROMPT.trim());
  }

  it("staged for the next frame", async () => {
    const state = startWait();
    arrive(PROMPT);
    pressContinue();
    await heldBack(state);
  });

  it("in xterm's own queue", async () => {
    const state = startWait();
    terminals.block = true;
    arrive(PROMPT);
    await settle();
    pressContinue();
    await settle();
    expect(state.result).toBeUndefined();
    engine().unblock();
    await heldBack(state);
  });

  it("held for inline images", async () => {
    const state = startWait();
    imageHold.on = true;
    arrive(PROMPT);
    pressContinue();
    await settle();
    expect(state.result).toBeUndefined();
    imageHold.on = false;
    await heldBack(state);
  });

  it("behind a backlog as large as the queue takes", async () => {
    const state = startWait();
    terminals.block = true;
    arrive("x".repeat(FLOW_HIGH_WATERMARK) + "\r\n");
    await settle();
    arrive(PROMPT);
    pressContinue();
    engine().unblock();
    await vi.waitFor(() => expect(wait()?.stillAsking).toBe(true), { timeout: 3000 });
    await heldBack(state);
  });

  it("in a plugin's parser", async () => {
    const state = startWait();
    const parser = slowParser();
    arrive(PROMPT);
    pressContinue();
    await settle();
    expect(state.result).toBeUndefined();
    parser();
    await heldBack(state);
  });

  it("in a plugin's parser, when a repaint drops and shows it", async () => {
    const state = startWait();
    slowParser();
    arrive(PROMPT);
    pressContinue();
    mockReplay.mockResolvedValue({ data: encoder.encode(PROMPT), endOffset: streamed, epoch: 1 });
    lose();
    regain();
    await heldBack(state);
  });

  it("without waiting for a frame, which a background window does not serve", () => {
    startWait();
    arrive(PROMPT);
    const { write } = engine();
    write.mockClear();
    pressContinue();
    expect(write).toHaveBeenCalledOnce();
  });

  it("not of a terminal that is gone", () => {
    expect(promptOfTerminal(tabId)).toBeDefined();
    act(() => root.unmount());
    expect(promptOfTerminal(tabId)).toBeUndefined();
    root = createRoot(container);
  });

  it("while the session is being repainted", async () => {
    const state = startWait();
    let shown = (_: unknown) => {};
    mockReplay.mockReturnValue(new Promise((resolve) => (shown = resolve)));
    lose();
    regain();
    expect(mockReplay).toHaveBeenCalled();
    pressContinue();
    await settle();
    expect(state.result).toBeUndefined();
    await act(async () =>
      shown({ data: encoder.encode(`$ sudo\r\n${PROMPT}`), endOffset: streamed, epoch: 1 })
    );
    await heldBack(state);
  });

  it("which a repaint that began meanwhile drops and shows again", async () => {
    const state = startWait();
    terminals.block = true;
    arrive(PROMPT);
    pressContinue();
    mockReplay.mockResolvedValue({
      data: encoder.encode(`$ sudo\r\n${PROMPT}`),
      endOffset: streamed,
      epoch: 1,
    });
    lose();
    regain();
    await settle();
    expect(state.result).toBeUndefined();
    engine().unblock();
    await heldBack(state);
  });

  it("while another window has the terminal: nothing goes on", async () => {
    const state = startWait();
    lose();
    pressContinue();
    pressContinue();
    await settle();
    expect(state.result).toBeUndefined();
    expect(wait()?.elsewhere).toBe(true);
  });

  it("and what comes after it counts too, in order", async () => {
    const state = startWait();
    arrive(PROMPT);
    arrive("\r\nSorry\r\n$ ");
    pressContinue();
    await settle(60);
    expect(state.result).toBe("continued");
  });

  it("does not wait for output that never ends", async () => {
    const state = startWait();
    const flood = setInterval(() => arrive("y\r\n"), 1);
    await settle();
    pressContinue();
    await settle(120);
    clearInterval(flood);
    expect(state.result).toBe("continued");
  });

  it("asks when it cannot tell in time, and an insisting press goes on", async () => {
    const state = startWait();
    terminals.block = true;
    arrive("whatever");
    pressContinue();
    await settle(200);
    expect(wait()?.checking).toBe(true);
    await settle(1000);
    expect(wait()).toMatchObject({ unchecked: true, checking: false });
    expect(state.result).toBeUndefined();
    pressContinue();
    pressContinue();
    await settle(1200);
    expect(state.result).toBe("continued");
  });

  it("a second press while it looks is not an insisting one", async () => {
    const state = startWait();
    arrive(PROMPT);
    pressContinue();
    pressContinue();
    await heldBack(state);
  });

  it("insisting on one prompt does not go on at the next one", async () => {
    const state = startWait();
    arrive(PROMPT);
    pressContinue();
    await heldBack(state);
    arrive(`\r\nSorry, try again.\r\n${PROMPT}`);
    pressContinue();
    await settle(60);
    expect(state.result).toBeUndefined();
    pressContinue();
    await settle();
    expect(state.result).toBe("continued");
  });

  it("nor at one in the same place of a full scrollback", async () => {
    const state = startWait();
    arrive("line\r\n".repeat(3000) + PROMPT);
    await settle(80);
    pressContinue();
    await heldBack(state);
    arrive(`\r\nSorry, try again.\r\n${PROMPT}`);
    pressContinue();
    await settle(60);
    expect(state.result).toBeUndefined();
  });

  it.each([
    ["shows another terminal", () => void store().addTab("Other", "local")],
    ["loses the terminal to another window", () => store().setSessionOwners({ [SID]: "win-1" })],
  ])("does not go on when the user %s while it looks", async (_, away) => {
    const state = startWait();
    terminals.block = true;
    arrive("output");
    await settle();
    pressContinue();
    act(away);
    engine().unblock();
    await settle(60);
    expect(state.result).toBeUndefined();
    expect(wait()).toBeDefined();
  });

  it("a run stopped while it looks is not continued", async () => {
    startWait();
    terminals.block = true;
    arrive(PROMPT);
    pressContinue();
    useAppStore.setState({ automationWaits: [] });
    engine().unblock();
    await settle(60);
    expect(store().automationWaits).toEqual([]);
  });
});

describe("The recorder sees a prompt that has arrived (#6070)", () => {
  /** Type into the terminal like a user, then stop recording. */
  async function typed(...chunks: string[]) {
    for (const chunk of chunks) act(() => engine().typed(chunk));
  }
  async function stopped() {
    await settle(60);
    act(() => store().stopRecording());
    const take = store().recordedTake!;
    return { data: take.chunks.map((c) => c.data), secrets: take.secrets };
  }
  beforeEach(() => {
    act(() => void store().startRecording({ tabId }));
    expect(store().recording).not.toBeNull();
  });

  it("staged for the next frame", async () => {
    arrive(PROMPT);
    await typed("h", "i", "\r");
    const { data, secrets } = await stopped();
    expect(data.join("")).toBe("hi\r");
    expect(secrets).toEqual([{ start: 0, end: 3, prompt: PROMPT.trim() }]);
  });

  it("and says so while recording", async () => {
    arrive(PROMPT);
    await typed("h");
    await settle();
    expect(store().recording?.atPrompt).toBe(true);
  });

  it("also when the whole answer is sent before any of it shows", async () => {
    terminals.block = true;
    arrive(PROMPT);
    await typed("hunter2\r");
    arrive("\r\n$ ");
    await typed("ls\r");
    engine().unblock();
    const { secrets } = await stopped();
    expect(secrets).toEqual([{ start: 0, end: 1, prompt: PROMPT.trim() }]);
  });

  it("in a plugin's parser", async () => {
    const parser = slowParser();
    arrive(PROMPT);
    await typed("x\r");
    await settle();
    parser();
    const { secrets } = await stopped();
    expect(secrets).toEqual([{ start: 0, end: 1, prompt: PROMPT.trim() }]);
  });

  it("and keeps apart what it cannot tell when it is stopped", async () => {
    terminals.block = true;
    arrive("output");
    await typed("secret?");
    const { secrets } = await stopped();
    expect(secrets).toEqual([{ start: 0, end: 1, prompt: "" }]);
  });

  it("leaves ordinary typing as it is while output arrives", async () => {
    arrive("building…\r\n$ ");
    await typed("l", "s", "\r");
    expect((await stopped()).secrets).toEqual([]);
  });
});
