import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { PasswordBackupLink } from "./PasswordBackupLink";

/**
 * Settings ▸ Security ▸ Back up saved passwords (#5860, R-052): one backup flow.
 * The section points to Backup & restore in the words of the chosen store.
 */

let container: HTMLDivElement;
let root: Root;
const query = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

function render(mode: "master_password" | "os_keychain" | "none") {
  act(() => {
    useAppStore.setState({ credentialStoreStatus: { mode, status: "unlocked" } });
  });
  act(() => root.render(<PasswordBackupLink />));
}

describe("PasswordBackupLink (#5860)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("names the OS Keychain, not a vault, and offers no second export", () => {
    render("os_keychain");
    const text = query("password-backup")!.textContent ?? "";
    expect(text).toContain("OS Keychain");
    expect(text.toLowerCase()).not.toContain("vault");
    expect(text).not.toMatch(/Export|Import/);
  });

  it("names the master-password vault when that is the store", () => {
    render("master_password");
    expect(query("password-backup-description")?.textContent).toContain("master-password vault");
  });

  it("goes to Backup & restore", () => {
    render("os_keychain");
    act(() => query("password-backup-open")!.click());
    const state = useAppStore.getState();
    expect(state.pendingSettingsCategory).toBe("backup");
  });

  it("is its heading and one line while passwords are not saved", () => {
    render("none");
    const section = query("password-backup")!;
    expect(section.dataset.collapsed).toBe("true");
    expect(query("password-backup-open")).toBeNull();
    expect(section.querySelectorAll("p")).toHaveLength(1);
    expect(query("password-backup-unavailable")?.textContent).toMatch(
      /^Credential storage is off — choose .* above to back up saved passwords\.$/
    );
  });
});
