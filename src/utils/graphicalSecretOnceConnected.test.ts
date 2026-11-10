/**
 * The held VNC/RDP password write (#5197): it runs only on a connect success
 * for its own tab, and every other ending drops it unsaved.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

import { frontendLog } from "@/utils/frontendLog";
import {
  discardGraphicalSecret,
  graphicalConnectFailed,
  graphicalConnectSucceeded,
  hasHeldGraphicalSecret,
  holdGraphicalSecretUntilConnected,
} from "./graphicalSecretOnceConnected";

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  for (const tab of ["t1", "t2"]) discardGraphicalSecret(tab);
});

describe("holdGraphicalSecretUntilConnected", () => {
  it("writes once on success and only for its own tab", async () => {
    const persist = vi.fn(() => Promise.resolve());
    const outcome = holdGraphicalSecretUntilConnected("t1", persist);
    graphicalConnectSucceeded("t2");
    expect(persist).not.toHaveBeenCalled();
    graphicalConnectSucceeded("t1");
    graphicalConnectSucceeded("t1");
    await expect(outcome).resolves.toBe("persisted");
    expect(persist).toHaveBeenCalledTimes(1);
    expect(hasHeldGraphicalSecret("t1")).toBe(false);
  });

  it("drops the write on a failed connect", async () => {
    const persist = vi.fn(() => Promise.resolve());
    const outcome = holdGraphicalSecretUntilConnected("t1", persist);
    graphicalConnectFailed("t1");
    graphicalConnectSucceeded("t1");
    await expect(outcome).resolves.toBe("discarded");
    expect(persist).not.toHaveBeenCalled();
  });

  it("drops the write after the timeout", async () => {
    vi.useFakeTimers();
    const persist = vi.fn(() => Promise.resolve());
    const outcome = holdGraphicalSecretUntilConnected("t1", persist, { timeoutMs: 1000 });
    vi.advanceTimersByTime(1000);
    graphicalConnectSucceeded("t1");
    await expect(outcome).resolves.toBe("discarded");
    expect(persist).not.toHaveBeenCalled();
  });

  it("replaces an earlier held write for the same tab", async () => {
    const first = vi.fn(() => Promise.resolve());
    const second = vi.fn(() => Promise.resolve());
    const firstOutcome = holdGraphicalSecretUntilConnected("t1", first);
    const secondOutcome = holdGraphicalSecretUntilConnected("t1", second);
    await expect(firstOutcome).resolves.toBe("discarded");
    graphicalConnectSucceeded("t1");
    await expect(secondOutcome).resolves.toBe("persisted");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("reports a write that fails after connecting, without the secret", async () => {
    const outcome = holdGraphicalSecretUntilConnected("t1", () =>
      Promise.reject(new Error("keychain unavailable"))
    );
    graphicalConnectSucceeded("t1");
    await expect(outcome).resolves.toBe("failed");
    expect(vi.mocked(frontendLog)).toHaveBeenCalledWith(
      "graphical_secret",
      "Failed to store remote-desktop password: keychain unavailable"
    );
  });
});
