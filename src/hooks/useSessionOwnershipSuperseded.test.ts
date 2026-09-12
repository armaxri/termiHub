import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// A settable callback the mocked `onSessionOwnershipSuperseded` hands the event
// to, so a test can drive the superseded push-event directly (SM-026).
let emitSuperseded: ((payload: { sessionId: string; newOwner: string }) => void) | undefined;
const unlisten = vi.fn();
// Defers resolution of the listener-registration promise so a test can control
// the exact moment registration completes (in particular, unmounting first, to
// reproduce the FEC-017 late-registration leak).
let resolveReg: (() => void) | undefined;

vi.mock("@/services/events", () => ({
  onSessionOwnershipSuperseded: vi.fn(
    (cb: (payload: { sessionId: string; newOwner: string }) => void) => {
      emitSuperseded = cb;
      return new Promise<() => void>((resolve) => {
        resolveReg = () => resolve(unlisten);
      });
    }
  ),
}));

vi.mock("@/components/ui", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { useSessionOwnershipSuperseded } from "./useSessionOwnershipSuperseded";
import { toast } from "@/components/ui";

describe("useSessionOwnershipSuperseded (SM-026)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    emitSuperseded = undefined;
    resolveReg = undefined;
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function mountHook(): Promise<void> {
    function Harness() {
      useSessionOwnershipSuperseded();
      return null;
    }
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    // The subscription is set up asynchronously inside an effect.
    await act(async () => {
      resolveReg?.();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("surfaces an informational notice when the window is superseded", async () => {
    await mountHook();

    act(() => {
      emitSuperseded!({ sessionId: "s1", newOwner: "win-1" });
    });

    expect(vi.mocked(toast.info)).toHaveBeenCalledTimes(1);
    // The notice must explain that resize is disabled for this window.
    expect(String(vi.mocked(toast.info).mock.calls[0][0]).toLowerCase()).toMatch(/resize/);
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
  });

  it("unlistens a registration that resolves after teardown (leak guard, FEC-017)", async () => {
    function Harness() {
      useSessionOwnershipSuperseded();
      return null;
    }
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    // Registration has not completed, so no unlisten handle exists yet.
    expect(unlisten).not.toHaveBeenCalled();

    // Tear the effect down before the registration promise resolves.
    await act(async () => {
      root.unmount();
    });

    // The registration resolves late — it must be unlistened immediately so the
    // listener does not leak past the hook's life.
    await act(async () => {
      resolveReg?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
