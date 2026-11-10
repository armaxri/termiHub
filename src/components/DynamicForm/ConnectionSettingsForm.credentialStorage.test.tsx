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

  it("shows the save row disabled and unticked with an enable action in None mode", () => {
    render("none", { savePassword: true });
    const toggle = query("field-savePassword")!;
    expect(toggle.hasAttribute("disabled")).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(query("field-savePassword-storage-off")?.textContent).toContain(
      "Credential storage is off"
    );
    expect(query("field-savePassword-enable-storage")?.textContent).toBe(
      "Enable credential storage…"
    );
    // The password itself is still never pre-filled in None mode.
    expect(query("dynamic-field-password")).toBeNull();
  });

  it("opens Settings ▸ Security from the enable action", () => {
    render("none");
    act(() => {
      query("field-savePassword-enable-storage")!.click();
    });
    expect(useAppStore.getState().pendingSettingsCategory).toBe("security");
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
