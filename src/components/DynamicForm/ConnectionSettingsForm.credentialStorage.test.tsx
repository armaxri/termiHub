/**
 * #5186: with credential storage off (None mode) the editor keeps the
 * "Save credentials" row visible — disabled, with a "storage is off" hint and
 * an "Enable credential storage…" action that opens Settings ▸ Security —
 * instead of silently dropping it. With storage on the row is a normal toggle.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { SettingsSchema } from "@/types/schema";
import { useAppStore } from "@/store/appStore";
import { filterCredentialFields } from "@/utils/schemaDefaults";
import { ConnectionSettingsForm } from "./ConnectionSettingsForm";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn().mockResolvedValue(null) }));
vi.mock("@/services/api", () => ({ listSerialPorts: vi.fn().mockResolvedValue([]) }));

let container: HTMLDivElement;
let root: Root;
let lastSettings: Record<string, unknown> = {};

function query(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

/** Mirrors the SSH schema's authentication group (core `ssh/mod.rs`). */
const SCHEMA: SettingsSchema = {
  groups: [
    {
      key: "authentication",
      label: "Authentication",
      fields: [
        { key: "password", label: "Password", fieldType: { type: "password" }, required: false },
        {
          key: "savePassword",
          label: "Save credentials",
          description: "Store credentials for automatic login",
          helpText: "When enabled, termiHub saves your credentials.",
          fieldType: { type: "boolean" },
          required: false,
          default: false,
        },
      ],
    },
  ],
};

function render(mode: "none" | "os_keychain" | "master_password", settings = {}) {
  act(() => {
    root.render(
      <ConnectionSettingsForm
        schema={filterCredentialFields(SCHEMA, mode)}
        settings={settings}
        onChange={(s) => {
          lastSettings = s;
        }}
        credentialStorageOff={mode === "none"}
      />
    );
  });
}

function openHelp(): string {
  act(() => {
    query("field-savePassword-help")!.click();
  });
  return query("field-savePassword-help-dialog")?.textContent ?? "";
}

describe("ConnectionSettingsForm credential storage modes (#5186)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    lastSettings = {};
    useAppStore.setState(useAppStore.getInitialState());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("keeps the password field in None mode and says it is not saved (#5835)", () => {
    render("none", { savePassword: true });
    const toggle = query("field-savePassword")!;
    expect(toggle.hasAttribute("disabled")).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    // The password field stays beside its save toggle, empty.
    expect((query("field-password") as HTMLInputElement | null)?.value).toBe("");
    // It says plainly what a typed password is for, with #5838's line and link.
    expect(query("field-password-not-saved")?.textContent).toContain(
      "Passwords aren't saved. This one is used only for Test and this connect."
    );
    expect(query("field-password-turn-on-saving")?.textContent).toBe("Turn on saving…");
    expect(query("field-password")!.getAttribute("aria-describedby")).toContain("not-saved");
    // One note, not two: the save row drops its own storage-off copy.
    expect(query("field-savePassword-storage-off")).toBeNull();
  });

  it("opens Settings ▸ Security from Turn on saving…", () => {
    render("none");
    act(() => {
      query("field-password-turn-on-saving")!.click();
    });
    expect(useAppStore.getState().pendingSettingsCategory).toBe("security");
  });

  it("keeps the save row's own note when no password field is shown", () => {
    act(() => {
      root.render(
        <ConnectionSettingsForm
          schema={filterCredentialFields(SCHEMA, "none")}
          settings={{}}
          onChange={() => {}}
          credentialStorageOff
          hiddenFieldKeys={["password"]}
        />
      );
    });
    expect(query("field-password-not-saved")).toBeNull();
    expect(query("field-savePassword-storage-off")?.textContent).toContain(
      "Credential storage is off"
    );
    expect(query("field-savePassword-enable-storage")?.textContent).toBe(
      "Enable credential storage…"
    );
  });

  it("says nothing about saving once storage is on", () => {
    render("os_keychain");
    expect(query("field-password-not-saved")).toBeNull();
  });

  it("does not rewrite the stored save flag while storage is off", () => {
    render("none", { savePassword: true });
    expect(lastSettings.savePassword).not.toBe(false);
  });

  it("says storage is off in the None-mode help", () => {
    render("none");
    const help = openHelp();
    expect(help).toContain("Credential storage is off");
    expect(help).not.toMatch(/master password/i);
  });

  it("names the OS keychain in OS Keychain mode, with no enable action", () => {
    render("os_keychain");
    expect(query("field-savePassword")!.hasAttribute("disabled")).toBe(false);
    expect(query("field-savePassword-enable-storage")).toBeNull();
    const help = openHelp();
    expect(help).toContain("keychain");
    expect(help).not.toMatch(/master password/i);
  });

  it("explains the master-password vault in Master Password mode", () => {
    render("master_password");
    expect(query("field-savePassword-enable-storage")).toBeNull();
    expect(openHelp()).toContain("master password");
  });
});
