/**
 * Submit-lifecycle parity for the SecuritySettings credential dialogs (#1469).
 *
 * The master-password setup and change-password inline dialogs each expose a
 * primary `type="submit"` Button. Both entry points must behave identically:
 *  - a mouse **click** drives the async Button lifecycle (pending affordance),
 *  - pressing **Enter** (form submit) drives the *same* pending affordance.
 *
 * Before #1469 the Enter path ran the bare form handler with no Button
 * lifecycle (and setup showed only a hand-rolled "Switching…" label), so these
 * tests are the regression guard for the shared bridge.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { SecuritySettings } from "./SecuritySettings";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return { ...actual, toast: { success: vi.fn(), error: vi.fn() } };
});

const mockedInvoke = vi.mocked(invoke);

let container: HTMLDivElement;
let root: Root;

/** A promise whose resolution the test controls, to freeze the pending state. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function el<T extends HTMLElement>(testId: string): T {
  return container.querySelector<T>(`[data-testid="${testId}"]`)!;
}

function fill(testId: string, value: string) {
  const input = el<HTMLInputElement>(testId);
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
    input,
    value
  );
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function isPending(button: HTMLButtonElement): boolean {
  return (
    button.classList.contains("ui-btn--pending") && button.getAttribute("aria-busy") === "true"
  );
}

async function fireSubmit(formTestId: string) {
  await act(async () => {
    el<HTMLFormElement>(formTestId).dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true })
    );
  });
  await flush();
}

async function fireClick(buttonTestId: string) {
  await act(async () => {
    el<HTMLButtonElement>(buttonTestId).dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true })
    );
  });
  await flush();
}

describe("SecuritySettings — submit lifecycle parity (#1469)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function openMasterPasswordSetup() {
    useAppStore.setState({ credentialStoreStatus: { mode: "none", status: "unlocked" } });
    await act(async () => root.render(<SecuritySettings />));
    await act(async () => el<HTMLButtonElement>("storage-mode-master-password").click());
    await flush();
    fill("master-password-input", "supersecret1");
    fill("master-password-confirm-input", "supersecret1");
    await flush();
  }

  async function openChangePassword() {
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
    });
    await act(async () => root.render(<SecuritySettings />));
    await act(async () => el<HTMLButtonElement>("change-master-password-btn").click());
    await flush();
    fill("change-master-password-current", "oldsecret1");
    fill("change-master-password-new", "newsecret1");
    fill("change-master-password-confirm", "newsecret1");
    await flush();
  }

  it("master-password setup: clicking Confirm drives the pending affordance", async () => {
    const gate = deferred<{ migratedCount: number; warnings: string[] }>();
    mockedInvoke.mockImplementation((cmd) =>
      cmd === "switch_credential_store" ? gate.promise : Promise.resolve(undefined)
    );
    await openMasterPasswordSetup();

    await fireClick("master-password-confirm-btn");

    expect(isPending(el<HTMLButtonElement>("master-password-confirm-btn"))).toBe(true);
    gate.resolve({ migratedCount: 0, warnings: [] });
  });

  it("master-password setup: Enter drives the SAME pending affordance", async () => {
    const gate = deferred<{ migratedCount: number; warnings: string[] }>();
    mockedInvoke.mockImplementation((cmd) =>
      cmd === "switch_credential_store" ? gate.promise : Promise.resolve(undefined)
    );
    await openMasterPasswordSetup();

    await fireSubmit("master-password-setup");

    expect(mockedInvoke).toHaveBeenCalledWith(
      "switch_credential_store",
      expect.objectContaining({ newMode: "master_password", masterPassword: "supersecret1" })
    );
    expect(isPending(el<HTMLButtonElement>("master-password-confirm-btn"))).toBe(true);
    gate.resolve({ migratedCount: 0, warnings: [] });
  });

  it("change-password: clicking Change drives the pending affordance", async () => {
    const gate = deferred<undefined>();
    mockedInvoke.mockImplementation((cmd) =>
      cmd === "change_master_password" ? gate.promise : Promise.resolve(undefined)
    );
    await openChangePassword();

    await fireClick("change-master-password-confirm-btn");

    expect(isPending(el<HTMLButtonElement>("change-master-password-confirm-btn"))).toBe(true);
    gate.resolve(undefined);
  });

  it("change-password: Enter drives the SAME pending affordance", async () => {
    const gate = deferred<undefined>();
    mockedInvoke.mockImplementation((cmd) =>
      cmd === "change_master_password" ? gate.promise : Promise.resolve(undefined)
    );
    await openChangePassword();

    await fireSubmit("change-password-dialog");

    expect(mockedInvoke).toHaveBeenCalledWith(
      "change_master_password",
      expect.objectContaining({ currentPassword: "oldsecret1", newPassword: "newsecret1" })
    );
    expect(isPending(el<HTMLButtonElement>("change-master-password-confirm-btn"))).toBe(true);
    gate.resolve(undefined);
  });
});
