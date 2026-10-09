/**
 * Table-driven test of every `on*` event wrapper in `events.ts` (TFE2-006,
 * #4344): each subscribes to the documented Tauri event (a `TAURI_EVENT` name)
 * and forwards the event to its callback. Most wrappers were otherwise only
 * ever registered in tests, never fired, so their forwarding line had no
 * coverage.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return Promise.resolve(() => {});
  }),
}));

import * as events from "./events";
import { TAURI_EVENT } from "./eventNames";

type Wrapper = (callback: (...args: unknown[]) => void) => Promise<unknown>;

/** Payloads for wrappers that read specific fields; others get a generic object. */
const PAYLOADS: Record<string, unknown> = {
  onTerminalOutput: { session_id: "s-1", data: "aGk=" },
  onPersistentSessionStateChanged: {
    connection_id: "c-1",
    session_id: "s-1",
    state: "connected",
    attached_tab_count: 1,
    error_message: null,
  },
  onTerminalExit: { session_id: "s-1", exit_code: 3 },
  onAgentSetupProgress: { agentId: "a-1", step: "upload", message: "Uploading" },
  onAgentUpdateAvailable: {
    agent_id: "a-1",
    currentVersion: "0.1.0",
    availableVersion: "0.2.0",
    staged: true,
  },
  onRemoteAgentUpdatePending: {
    agent_id: "a-1",
    requestedByVersion: "0.2.0",
    estimatedRestartSecs: 5,
  },
  onVscodeEditComplete: { remotePath: "/r/f", success: false, error: "boom" },
  onLocalFileChanged: { watchId: "w-1", path: "/p/f" },
  onLocalDirChanged: { watchId: "w-2", path: "/p/d" },
  onCredentialStoreLocked: { auto: true },
};

/** What each transforming wrapper hands its callback. */
const EXPECTED_ARGS: Record<string, unknown[]> = {
  onTerminalOutput: ["s-1", new Uint8Array([104, 105])],
  onPersistentSessionStateChanged: [
    {
      connectionId: "c-1",
      sessionId: "s-1",
      state: "connected",
      attachedTabCount: 1,
      errorMessage: null,
    },
  ],
  onTerminalExit: ["s-1", 3],
  onAgentSetupProgress: ["a-1", "upload", "Uploading"],
  onAgentUpdateAvailable: [
    { agentId: "a-1", currentVersion: "0.1.0", availableVersion: "0.2.0", staged: true },
  ],
  onRemoteAgentUpdatePending: [
    { agentId: "a-1", requestedByVersion: "0.2.0", estimatedRestartSecs: 5 },
  ],
  onVscodeEditComplete: ["/r/f", false, "boom"],
  onLocalFileChanged: ["w-1", "/p/f"],
  onLocalDirChanged: ["w-2", "/p/d"],
  onCredentialStoreLocked: [true],
};

const wrappers = Object.entries(events).filter(
  (entry): entry is [string, Wrapper] => /^on[A-Z]/.test(entry[0]) && typeof entry[1] === "function"
);

describe("events.ts wrappers forward their event (TFE2-006)", () => {
  beforeEach(() => listeners.clear());

  it("finds the wrappers", () => {
    expect(wrappers.length).toBeGreaterThan(25);
  });

  it.each(wrappers)("%s subscribes to a TAURI_EVENT name and forwards it", async (name, fn) => {
    const callback = vi.fn();
    await fn(callback);

    expect(listeners.size).toBe(1);
    const [eventName, handler] = [...listeners.entries()][0];
    expect(Object.values(TAURI_EVENT)).toContain(eventName);

    const payload = PAYLOADS[name] ?? { marker: name };
    handler({ payload });

    expect(callback).toHaveBeenCalledTimes(1);
    const expected = EXPECTED_ARGS[name];
    if (expected) {
      expect(callback.mock.calls[0]).toEqual(expected);
    } else if (callback.mock.calls[0].length > 0) {
      expect(callback.mock.calls[0][0]).toEqual(payload);
    }
  });
});
