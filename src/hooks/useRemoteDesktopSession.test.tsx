/**
 * Tests for {@link useRemoteDesktopSession} — the protocol-blind hook that owns
 * one graphical remote-desktop session (#1680). It drives the mock backend
 * through the generic `remote_desktop_*` commands and `remote-desktop-*` events,
 * exercising the shared lifecycle: connecting → active → resize → view-only →
 * reconnect.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { useRemoteDesktopSession, type RemoteDesktopSession } from "./useRemoteDesktopSession";
import {
  remoteDesktopConnect,
  remoteDesktopDisconnect,
  remoteDesktopResize,
  remoteDesktopSendInput,
  remoteDesktopSendClipboard,
  remoteDesktopCertDecision,
} from "@/services/api";
import type {
  RemoteDesktopStatePayload,
  RemoteDesktopCertPromptPayload,
} from "@/types/remoteDesktop";

const hoisted = vi.hoisted(() => ({
  stateCbs: [] as Array<(p: unknown) => void>,
  clipCbs: [] as Array<(p: unknown) => void>,
  certCbs: [] as Array<(p: unknown) => void>,
}));

vi.mock("@/services/api", () => ({
  remoteDesktopConnect: vi.fn(() => Promise.resolve("rd-1")),
  remoteDesktopDisconnect: vi.fn(() => Promise.resolve()),
  remoteDesktopResize: vi.fn(() => Promise.resolve()),
  remoteDesktopSendInput: vi.fn(() => Promise.resolve()),
  remoteDesktopSendClipboard: vi.fn(() => Promise.resolve()),
  remoteDesktopGetClipboard: vi.fn(() => Promise.resolve(null)),
  remoteDesktopCertDecision: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/services/events", () => ({
  onRemoteDesktopState: (cb: (p: unknown) => void) => {
    hoisted.stateCbs.push(cb);
    return Promise.resolve(() => {});
  },
  onRemoteDesktopClipboard: (cb: (p: unknown) => void) => {
    hoisted.clipCbs.push(cb);
    return Promise.resolve(() => {});
  },
  onRemoteDesktopCertPrompt: (cb: (p: unknown) => void) => {
    hoisted.certCbs.push(cb);
    return Promise.resolve(() => {});
  },
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

const mockedConnect = vi.mocked(remoteDesktopConnect);
const mockedDisconnect = vi.mocked(remoteDesktopDisconnect);
const mockedResize = vi.mocked(remoteDesktopResize);
const mockedSendInput = vi.mocked(remoteDesktopSendInput);
const mockedSendClipboard = vi.mocked(remoteDesktopSendClipboard);
const mockedCertDecision = vi.mocked(remoteDesktopCertDecision);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
  mockedConnect.mockResolvedValue("rd-1");
  hoisted.stateCbs.length = 0;
  hoisted.clipCbs.length = 0;
  hoisted.certCbs.length = 0;
  useAppStore.setState(useAppStore.getInitialState());
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Add a remote-desktop tab and return its id. */
function addTab(viewOnly = false): string {
  return useAppStore.getState().addTab(
    "Mock RD",
    "mock-remote-desktop",
    {
      type: "mock-remote-desktop",
      config: { host: "mock.local", viewOnly, scaleMode: "fit" },
    },
    { contentType: "remote-desktop" }
  );
}

/** Render the hook onto a closure so assertions read its latest value. */
function renderSession(tabId: string): { get: () => RemoteDesktopSession } {
  let latest: RemoteDesktopSession | null = null;
  function Probe() {
    latest = useRemoteDesktopSession(tabId);
    return null;
  }
  act(() => root.render(<Probe />));
  return {
    get: () => {
      if (!latest) throw new Error("hook not rendered");
      return latest;
    },
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function dispatchState(partial: Partial<RemoteDesktopStatePayload>) {
  const payload: RemoteDesktopStatePayload = {
    session_id: "rd-1",
    state: "active",
    reconnect_attempt: 0,
    ...partial,
  };
  act(() => hoisted.stateCbs.forEach((cb) => cb(payload)));
}

describe("useRemoteDesktopSession", () => {
  it("connects on mount with the tab's type and settings", async () => {
    const tabId = addTab();
    const h = renderSession(tabId);
    expect(h.get().state).toBe("connecting");

    await flush();

    expect(mockedConnect).toHaveBeenCalledOnce();
    expect(mockedConnect).toHaveBeenCalledWith("mock-remote-desktop", {
      host: "mock.local",
      viewOnly: false,
      scaleMode: "fit",
    });
    expect(h.get().sessionId).toBe("rd-1");
  });

  it("reflects lifecycle state events: active → resizing → reconnecting", async () => {
    const tabId = addTab();
    const h = renderSession(tabId);
    await flush();

    dispatchState({ state: "active" });
    expect(h.get().state).toBe("active");

    dispatchState({ state: "resizing" });
    expect(h.get().state).toBe("resizing");

    dispatchState({ state: "reconnecting", reconnect_attempt: 2 });
    expect(h.get().state).toBe("reconnecting");
    expect(h.get().reconnectAttempt).toBe(2);
  });

  it("forwards input when not view-only", async () => {
    const tabId = addTab(false);
    const h = renderSession(tabId);
    await flush();
    act(() => h.get().sendInput({ kind: "key", code: "KeyA", pressed: true }));
    expect(mockedSendInput).toHaveBeenCalledWith("rd-1", {
      kind: "key",
      code: "KeyA",
      pressed: true,
    });
  });

  it("suppresses input when view-only", async () => {
    const tabId = addTab(true);
    const h = renderSession(tabId);
    await flush();
    expect(h.get().viewOnly).toBe(true);
    act(() => h.get().sendInput({ kind: "pointer", x: 1, y: 2, buttons: 1 }));
    expect(mockedSendInput).not.toHaveBeenCalled();
  });

  it("requests a resize in pixels", async () => {
    const tabId = addTab();
    const h = renderSession(tabId);
    await flush();
    act(() => h.get().resize(640, 480));
    expect(mockedResize).toHaveBeenCalledWith("rd-1", 640, 480);
  });

  it("sends clipboard and reflects remote clipboard events", async () => {
    const tabId = addTab();
    const h = renderSession(tabId);
    await flush();

    act(() => h.get().sendClipboard("hello"));
    expect(mockedSendClipboard).toHaveBeenCalledWith("rd-1", "hello");

    act(() => hoisted.clipCbs.forEach((cb) => cb({ session_id: "rd-1", text: "from-remote" })));
    expect(h.get().remoteClipboard).toBe("from-remote");
  });

  it("surfaces a cert prompt and routes the accept-for-host verdict (#1767)", async () => {
    const tabId = addTab();
    const h = renderSession(tabId);
    await flush();

    const prompt: RemoteDesktopCertPromptPayload = {
      session_id: "rd-1",
      host: "mock.local:3389",
      fingerprint: "sha256:AA:BB:CC",
      changed: false,
    };
    act(() => hoisted.certCbs.forEach((cb) => cb(prompt)));
    expect(h.get().certPrompt).toEqual(prompt);

    act(() => h.get().respondCert(true, true));
    // Dialog clears optimistically and the verdict is routed to the backend.
    expect(h.get().certPrompt).toBeNull();
    expect(mockedCertDecision).toHaveBeenCalledWith("rd-1", true, true);
  });

  it("ignores a cert prompt for a different session", async () => {
    const tabId = addTab();
    const h = renderSession(tabId);
    await flush();

    act(() =>
      hoisted.certCbs.forEach((cb) =>
        cb({
          session_id: "other-session",
          host: "elsewhere",
          fingerprint: "sha256:ZZ",
          changed: true,
        })
      )
    );
    expect(h.get().certPrompt).toBeNull();
  });

  it("reconnects: tears down the old session and connects again", async () => {
    const tabId = addTab();
    const h = renderSession(tabId);
    await flush();
    expect(mockedConnect).toHaveBeenCalledTimes(1);

    act(() => h.get().reconnect());
    await flush();

    expect(mockedDisconnect).toHaveBeenCalledWith("rd-1");
    expect(mockedConnect).toHaveBeenCalledTimes(2);
  });
});
