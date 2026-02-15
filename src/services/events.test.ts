import { describe, it, expect, vi, beforeEach } from "vitest";
import { listen } from "@tauri-apps/api/event";
import {
  onTerminalOutput,
  onTerminalExit,
  onVscodeEditComplete,
  TerminalOutputDispatcher,
} from "./events";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

const mockedListen = vi.mocked(listen);

describe("events service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("onTerminalOutput", () => {
    it("registers listener on terminal-output event", async () => {
      const unlisten = vi.fn();
      mockedListen.mockResolvedValue(unlisten);

      const callback = vi.fn();
      const result = await onTerminalOutput(callback);

      expect(mockedListen).toHaveBeenCalledWith("terminal-output", expect.any(Function));
      expect(result).toBe(unlisten);
    });

    it("transforms payload and calls callback with Uint8Array", async () => {
      let capturedHandler: ((event: unknown) => void) | undefined;
      mockedListen.mockImplementation((_event, handler) => {
        capturedHandler = handler as (event: unknown) => void;
        return Promise.resolve(vi.fn());
      });

      const callback = vi.fn();
      await onTerminalOutput(callback);

      // Simulate Tauri event
      capturedHandler!({
        payload: { session_id: "sess-1", data: [72, 101, 108, 108, 111] },
      });

      expect(callback).toHaveBeenCalledWith("sess-1", expect.any(Uint8Array));
      const data = callback.mock.calls[0][1] as Uint8Array;
      expect(Array.from(data)).toEqual([72, 101, 108, 108, 111]);
    });
  });

  describe("onTerminalExit", () => {
    it("registers listener on terminal-exit event", async () => {
      const unlisten = vi.fn();
      mockedListen.mockResolvedValue(unlisten);

      const callback = vi.fn();
      const result = await onTerminalExit(callback);

      expect(mockedListen).toHaveBeenCalledWith("terminal-exit", expect.any(Function));
      expect(result).toBe(unlisten);
    });

    it("transforms payload and calls callback with exit code", async () => {
      let capturedHandler: ((event: unknown) => void) | undefined;
      mockedListen.mockImplementation((_event, handler) => {
        capturedHandler = handler as (event: unknown) => void;
        return Promise.resolve(vi.fn());
      });

      const callback = vi.fn();
      await onTerminalExit(callback);

      capturedHandler!({
        payload: { session_id: "sess-1", exit_code: 0 },
      });

      expect(callback).toHaveBeenCalledWith("sess-1", 0);
    });

    it("passes null exit code when process is killed", async () => {
      let capturedHandler: ((event: unknown) => void) | undefined;
      mockedListen.mockImplementation((_event, handler) => {
        capturedHandler = handler as (event: unknown) => void;
        return Promise.resolve(vi.fn());
      });

      const callback = vi.fn();
      await onTerminalExit(callback);

      capturedHandler!({
        payload: { session_id: "sess-1", exit_code: null },
      });

      expect(callback).toHaveBeenCalledWith("sess-1", null);
    });
  });

  describe("onVscodeEditComplete", () => {
    it("registers listener on vscode-edit-complete event", async () => {
      const unlisten = vi.fn();
      mockedListen.mockResolvedValue(unlisten);

      const callback = vi.fn();
      const result = await onVscodeEditComplete(callback);

      expect(mockedListen).toHaveBeenCalledWith("vscode-edit-complete", expect.any(Function));
      expect(result).toBe(unlisten);
    });

    it("calls callback with success payload", async () => {
      let capturedHandler: ((event: unknown) => void) | undefined;
      mockedListen.mockImplementation((_event, handler) => {
        capturedHandler = handler as (event: unknown) => void;
        return Promise.resolve(vi.fn());
      });

      const callback = vi.fn();
      await onVscodeEditComplete(callback);

      capturedHandler!({
        payload: { remotePath: "/remote/file.txt", success: true, error: null },
      });

      expect(callback).toHaveBeenCalledWith("/remote/file.txt", true, null);
    });

    it("calls callback with error payload", async () => {
      let capturedHandler: ((event: unknown) => void) | undefined;
      mockedListen.mockImplementation((_event, handler) => {
        capturedHandler = handler as (event: unknown) => void;
        return Promise.resolve(vi.fn());
      });

      const callback = vi.fn();
      await onVscodeEditComplete(callback);

      capturedHandler!({
        payload: { remotePath: "/remote/file.txt", success: false, error: "Upload failed" },
      });

      expect(callback).toHaveBeenCalledWith("/remote/file.txt", false, "Upload failed");
    });
  });

  describe("TerminalOutputDispatcher", () => {
    let dispatcher: TerminalOutputDispatcher;

    beforeEach(() => {
      dispatcher = new TerminalOutputDispatcher();
    });

    it("init registers three global listeners", async () => {
      mockedListen.mockResolvedValue(vi.fn());

      await dispatcher.init();

      expect(mockedListen).toHaveBeenCalledTimes(3);
      expect(mockedListen).toHaveBeenCalledWith("terminal-output", expect.any(Function));
      expect(mockedListen).toHaveBeenCalledWith("terminal-exit", expect.any(Function));
      expect(mockedListen).toHaveBeenCalledWith("remote-state-change", expect.any(Function));
    });

    it("init is idempotent — second call does nothing", async () => {
      mockedListen.mockResolvedValue(vi.fn());

      await dispatcher.init();
      await dispatcher.init();

      expect(mockedListen).toHaveBeenCalledTimes(3);
    });

    it("routes output events to the correct session callback", async () => {
      const handlers: Record<string, (event: unknown) => void> = {};
      mockedListen.mockImplementation((eventName, handler) => {
        handlers[eventName as string] = handler as (event: unknown) => void;
        return Promise.resolve(vi.fn());
      });

      await dispatcher.init();

      const cb1 = vi.fn();
      const cb2 = vi.fn();
      dispatcher.subscribeOutput("sess-1", cb1);
      dispatcher.subscribeOutput("sess-2", cb2);

      // Emit event for sess-1
      handlers["terminal-output"]({
        payload: { session_id: "sess-1", data: [65, 66] },
      });

      expect(cb1).toHaveBeenCalledTimes(1);
      expect(cb1).toHaveBeenCalledWith(expect.any(Uint8Array));
      expect(Array.from(cb1.mock.calls[0][0] as Uint8Array)).toEqual([65, 66]);
      expect(cb2).not.toHaveBeenCalled();
    });

    it("routes exit events to the correct session callback", async () => {
      const handlers: Record<string, (event: unknown) => void> = {};
      mockedListen.mockImplementation((eventName, handler) => {
        handlers[eventName as string] = handler as (event: unknown) => void;
        return Promise.resolve(vi.fn());
      });

      await dispatcher.init();

      const cb = vi.fn();
      dispatcher.subscribeExit("sess-1", cb);

      handlers["terminal-exit"]({
        payload: { session_id: "sess-1", exit_code: 0 },
      });

      expect(cb).toHaveBeenCalledWith(0);
    });

    it("routes remote state events to the correct session callback", async () => {
      const handlers: Record<string, (event: unknown) => void> = {};
      mockedListen.mockImplementation((eventName, handler) => {
        handlers[eventName as string] = handler as (event: unknown) => void;
        return Promise.resolve(vi.fn());
      });

      await dispatcher.init();

      const cb = vi.fn();
      dispatcher.subscribeRemoteState("sess-1", cb);

      handlers["remote-state-change"]({
        payload: { session_id: "sess-1", state: "connected" },
      });

      expect(cb).toHaveBeenCalledWith("connected");
    });

    it("unsubscribe stops delivery", async () => {
      const handlers: Record<string, (event: unknown) => void> = {};
      mockedListen.mockImplementation((eventName, handler) => {
        handlers[eventName as string] = handler as (event: unknown) => void;
        return Promise.resolve(vi.fn());
      });

      await dispatcher.init();

      const cb = vi.fn();
      const unsub = dispatcher.subscribeOutput("sess-1", cb);

      // First event should be delivered
      handlers["terminal-output"]({
        payload: { session_id: "sess-1", data: [1] },
      });
      expect(cb).toHaveBeenCalledTimes(1);

      // After unsubscribe, no delivery
      unsub();
      handlers["terminal-output"]({
        payload: { session_id: "sess-1", data: [2] },
      });
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it("ignores events for unknown sessions", async () => {
      const handlers: Record<string, (event: unknown) => void> = {};
      mockedListen.mockImplementation((eventName, handler) => {
        handlers[eventName as string] = handler as (event: unknown) => void;
        return Promise.resolve(vi.fn());
      });

      await dispatcher.init();

      // No callback registered for "sess-unknown"
      // Should not throw
      handlers["terminal-output"]({
        payload: { session_id: "sess-unknown", data: [1] },
      });
    });

    it("destroy calls unlisten and clears callbacks", async () => {
      const unlistenOutput = vi.fn();
      const unlistenExit = vi.fn();
      const unlistenRemoteState = vi.fn();
      let callCount = 0;
      mockedListen.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(unlistenOutput);
        if (callCount === 2) return Promise.resolve(unlistenExit);
        return Promise.resolve(unlistenRemoteState);
      });

      await dispatcher.init();

      const cb = vi.fn();
      dispatcher.subscribeOutput("sess-1", cb);

      dispatcher.destroy();

      expect(unlistenOutput).toHaveBeenCalled();
      expect(unlistenExit).toHaveBeenCalled();
      expect(unlistenRemoteState).toHaveBeenCalled();
    });

    it("can be re-initialized after destroy", async () => {
      mockedListen.mockResolvedValue(vi.fn());

      await dispatcher.init();
      dispatcher.destroy();

      vi.clearAllMocks();
      mockedListen.mockResolvedValue(vi.fn());

      await dispatcher.init();

      expect(mockedListen).toHaveBeenCalledTimes(3);
    });
  });
});
