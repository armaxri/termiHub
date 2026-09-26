import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { BiometricUnlockSettings, enableErrorMessage } from "./BiometricUnlockSettings";
import {
  OS_AUTH_AVAILABLE,
  OS_AUTH_BIOMETRIC_ENABLED,
  OS_AUTH_UNAVAILABLE,
} from "@/test/osAuthFixtures";

vi.mock("@/services/api", async () => {
  const actual = await vi.importActual<typeof import("@/services/api")>("@/services/api");
  return {
    ...actual,
    getOsAuthInfo: vi.fn(),
    enableBiometricUnlock: vi.fn(),
    disableBiometricUnlock: vi.fn(),
  };
});

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return {
    ...actual,
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  };
});

import { disableBiometricUnlock, enableBiometricUnlock, getOsAuthInfo } from "@/services/api";
import { toast } from "@/components/ui";

const mockedInfo = vi.mocked(getOsAuthInfo);
const mockedEnable = vi.mocked(enableBiometricUnlock);
const mockedDisable = vi.mocked(disableBiometricUnlock);

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

async function click(testId: string) {
  await act(async () => {
    query(testId)!.click();
  });
}

function setPassword(value: string) {
  const input = query("biometric-unlock-password") as HTMLInputElement;
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
      input,
      value
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function renderLoaded(status: "unlocked" | "locked" = "unlocked") {
  useAppStore.setState({ credentialStoreStatus: { mode: "master_password", status } });
  await act(async () => {
    root.render(<BiometricUnlockSettings />);
  });
  await act(async () => {});
}

describe("BiometricUnlockSettings", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
    mockedInfo.mockResolvedValue(OS_AUTH_AVAILABLE);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("is hidden where the OS has no biometric verification", async () => {
    mockedInfo.mockResolvedValue(OS_AUTH_UNAVAILABLE);
    await renderLoaded();
    expect(query("biometric-unlock-settings")).toBeNull();
  });

  it("turns on after the master password and the OS prompt", async () => {
    await renderLoaded();
    expect(query("biometric-unlock-settings")?.textContent).toContain("Unlock with Touch ID");

    await click("biometric-unlock-toggle");
    expect(query("biometric-unlock-enable-form")).not.toBeNull();

    mockedEnable.mockResolvedValue(OS_AUTH_BIOMETRIC_ENABLED.biometricUnlock);
    mockedInfo.mockResolvedValue(OS_AUTH_BIOMETRIC_ENABLED);
    setPassword("master-pw");
    await click("biometric-unlock-enable-btn");

    expect(mockedEnable).toHaveBeenCalledWith("master-pw");
    expect(toast.success).toHaveBeenCalled();
    expect(query("biometric-unlock-enable-form")).toBeNull();
    expect(query("biometric-unlock-toggle")?.getAttribute("aria-checked")).toBe("true");
  });

  it("requires the master password before prompting", async () => {
    await renderLoaded();
    await click("biometric-unlock-toggle");
    await click("biometric-unlock-enable-btn");
    expect(mockedEnable).not.toHaveBeenCalled();
    expect(query("biometric-unlock-error")?.textContent).toMatch(/master password/);
  });

  it("shows a wrong password or cancelled prompt inline", async () => {
    await renderLoaded();
    await click("biometric-unlock-toggle");

    mockedEnable.mockRejectedValueOnce({ kind: "wrongMasterPassword", message: "x" });
    setPassword("nope");
    await click("biometric-unlock-enable-btn");
    expect(query("biometric-unlock-error")?.textContent).toBe("The master password is incorrect.");

    mockedEnable.mockRejectedValueOnce({ kind: "cancelled", message: "x" });
    setPassword("master-pw");
    await click("biometric-unlock-enable-btn");
    expect(query("biometric-unlock-error")?.textContent).toMatch(/cancelled/);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("turns off by deleting the stored key", async () => {
    mockedInfo.mockResolvedValue(OS_AUTH_BIOMETRIC_ENABLED);
    await renderLoaded();
    mockedDisable.mockResolvedValue(OS_AUTH_AVAILABLE.biometricUnlock);
    mockedInfo.mockResolvedValue(OS_AUTH_AVAILABLE);
    await click("biometric-unlock-toggle");
    expect(mockedDisable).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalled();
    expect(query("biometric-unlock-toggle")?.getAttribute("aria-checked")).toBe("false");
  });

  it("asks to unlock a locked store before opting in", async () => {
    const requestUnlock = vi.fn().mockResolvedValue(false);
    useAppStore.setState({ requestUnlock });
    await renderLoaded("locked");
    await click("biometric-unlock-toggle");
    expect(requestUnlock).toHaveBeenCalledTimes(1);
    expect(query("biometric-unlock-enable-form")).toBeNull();
  });

  it("maps error kinds to messages", () => {
    expect(enableErrorMessage(new Error("boom"), "Touch ID")).toBe("boom");
    expect(enableErrorMessage({ kind: "authFailed", message: "locked out" }, "Touch ID")).toBe(
      "locked out"
    );
  });
});
