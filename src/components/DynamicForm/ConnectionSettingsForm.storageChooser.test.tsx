/**
 * #5187: before any credential-storage choice exists, the editor's "Save
 * credentials" toggle is live but off; turning it on first opens the one-time
 * storage chooser and only turns on once a store is set up.
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
          helpText: "When enabled, termiHub saves your credentials.",
          fieldType: { type: "boolean" },
          required: false,
          default: false,
        },
      ],
    },
  ],
};

function render(settings: Record<string, unknown> = {}) {
  act(() => {
    root.render(
      <ConnectionSettingsForm
        schema={filterCredentialFields(SCHEMA, "none", true)}
        settings={settings}
        onChange={(s) => {
          lastSettings = s;
        }}
        credentialStorageChoose
      />
    );
  });
}

async function toggleOn() {
  await act(async () => {
    query("field-savePassword")!.click();
  });
}

describe("ConnectionSettingsForm first-use storage chooser (#5187)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    lastSettings = {};
    useAppStore.setState(useAppStore.getInitialState());
    useAppStore.setState({
      credentialStoreStatus: { mode: "none", status: "unavailable", storageChosen: false },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the toggle live and off, with no storage-off row", () => {
    render({ savePassword: true });
    const toggle = query("field-savePassword")!;
    expect(toggle.hasAttribute("disabled")).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(query("field-savePassword-storage-off")).toBeNull();
  });

  it("asks where to store before turning on, and turns on once a store is chosen", async () => {
    render();
    await toggleOn();
    expect(useAppStore.getState().storageChooserOpen).toBe(true);
    expect(lastSettings.savePassword).not.toBe(true);

    await act(async () => {
      useAppStore.getState().resolveStorageChoice("os_keychain");
    });

    expect(lastSettings.savePassword).toBe(true);
  });

  it("stays off when the chooser is canceled", async () => {
    render();
    await toggleOn();
    await act(async () => {
      useAppStore.getState().resolveStorageChoice("canceled");
    });

    expect(lastSettings.savePassword).not.toBe(true);
  });

  it("stays off when the user chooses not to save", async () => {
    render();
    await toggleOn();
    await act(async () => {
      useAppStore.getState().resolveStorageChoice("none");
    });

    expect(lastSettings.savePassword).not.toBe(true);
  });

  it("explains in the help that turning it on asks once", () => {
    render();
    act(() => {
      query("field-savePassword-help")!.click();
    });
    const help = query("field-savePassword-help-dialog")?.textContent ?? "";
    expect(help).toContain("asks once where termiHub should keep passwords");
    expect(help).not.toContain("Credential storage is off");
  });
});
