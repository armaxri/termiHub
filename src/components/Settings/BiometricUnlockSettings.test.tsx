import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import {
  BiometricUnlockSettings,
  enableErrorMessage,
  protectionNote,
} from "./BiometricUnlockSettings";
import {
  OS_AUTH_AVAILABLE,
  OS_AUTH_BIOMETRIC_ENABLED,
  OS_AUTH_UNAVAILABLE,
} from "@/test/osAuthFixtures";
import { contrastRatio } from "@/themes/contrast";
import { darkTheme } from "@/themes/dark";
import { lightTheme } from "@/themes/light";
import { solarizedDarkTheme } from "@/themes/solarized-dark";
import { solarizedLightTheme } from "@/themes/solarized-light";

const BUILT_IN_THEMES = [darkTheme, lightTheme, solarizedDarkTheme, solarizedLightTheme];

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
    expect(query("biometric-unlock-error")?.textContent).toMatch(/canceled/);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("turns off by deleting the stored key", async () => {
    mockedInfo.mockResolvedValue(OS_AUTH_BIOMETRIC_ENABLED);
    await renderLoaded();
    expect(query("biometric-unlock-protection")?.textContent).toBe(
      "Less secure: other apps running as you could read the unlock key."
    );
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

  it("hides the protection note while unlock is off", async () => {
    await renderLoaded();
    expect(query("biometric-unlock-toggle")?.getAttribute("aria-checked")).toBe("false");
    expect(query("biometric-unlock-protection")).toBeNull();
    // Still hidden while the enable form is open: the unlock is not on yet.
    await click("biometric-unlock-toggle");
    expect(query("biometric-unlock-enable-form")).not.toBeNull();
    expect(query("biometric-unlock-protection")).toBeNull();
  });

  it("shows the plain warning with the warning-hint icon while unlock is on", async () => {
    mockedInfo.mockResolvedValue(OS_AUTH_BIOMETRIC_ENABLED);
    await renderLoaded();
    const note = query("biometric-unlock-protection")!;
    expect(note.textContent).toBe(
      "Less secure: other apps running as you could read the unlock key."
    );
    expect(note.dataset.tone).toBe("warning");
    expect(note.classList.contains("settings-form__hint--warning")).toBe(true);
    const icon = note.querySelector("svg.ui-field__hint-icon");
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(note.textContent).not.toMatch(/OS-enforced/);
  });

  it("shows a short positive note, without the warning icon, for an OS-enforced key", async () => {
    mockedInfo.mockResolvedValue({
      ...OS_AUTH_BIOMETRIC_ENABLED,
      biometricUnlock: {
        ...OS_AUTH_BIOMETRIC_ENABLED.biometricUnlock,
        protection: "osEnforced",
        osEnforcedAvailable: true,
      },
    });
    await renderLoaded();
    const note = query("biometric-unlock-protection")!;
    expect(note.textContent).toBe(
      "Protected by the operating system: the unlock key needs Touch ID every time."
    );
    expect(note.dataset.tone).toBe("info");
    expect(note.classList.contains("settings-form__hint--warning")).toBe(false);
    expect(note.querySelector("svg")).toBeNull();
  });

  it("picks the note from the key's protection", () => {
    const base = OS_AUTH_AVAILABLE.biometricUnlock;
    // Off: no note, even where OS-enforced protection would be available.
    expect(protectionNote(base)).toBeNull();
    expect(protectionNote({ ...base, osEnforcedAvailable: true })).toBeNull();
    expect(
      protectionNote({
        ...base,
        enabled: true,
        protection: "osEnforced",
        osEnforcedAvailable: true,
      })
    ).toEqual({
      tone: "info",
      text: "Protected by the operating system: the unlock key needs Touch ID every time.",
    });
    expect(protectionNote({ ...base, enabled: true, protection: "app" })).toEqual({
      tone: "warning",
      text: "Less secure: other apps running as you could read the unlock key.",
    });
    // A legacy app-protected key on a build that can OS-enforce is upgraded on next unlock.
    const legacy = protectionNote({
      ...base,
      enabled: true,
      protection: "app",
      osEnforcedAvailable: true,
    });
    expect(legacy?.tone).toBe("warning");
    expect(legacy?.text).toMatch(
      /^Less secure: other apps running as you could read the unlock key\. /
    );
    expect(legacy?.text).toContain("next time you unlock with Touch ID");
  });

  // #5740: the warning note paints --color-warning as text on the plain
  // settings surface (no tint); the icon is a graphic (1.4.11).
  it.each(BUILT_IN_THEMES.map((theme) => [theme.id, theme] as const))(
    "%s: the warning note text reaches AA and its icon 3:1 on the settings surface",
    (_id, theme) => {
      for (const surface of [theme.colors.bgPrimary, theme.colors.bgSecondary]) {
        expect(contrastRatio(theme.colors.colorWarning, surface)).toBeGreaterThanOrEqual(4.5);
      }
    }
  );
});
