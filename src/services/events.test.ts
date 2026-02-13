import { describe, it, expect, vi, beforeEach } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { onTerminalOutput, onTerminalExit, onVscodeEditComplete } from "./events";

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
});
