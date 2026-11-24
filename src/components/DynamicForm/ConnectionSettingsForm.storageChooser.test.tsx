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
import { toast } from "@/components/ui";
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

function render(settings: Record<string, unknown> = {}, choose = true) {
  act(() => {
    root.render(
      <ConnectionSettingsForm
        schema={filterCredentialFields(SCHEMA, "none", true)}
        settings={settings}
        onChange={(s) => {
          lastSettings = s;
        }}
        credentialStorageChoose={choose}
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

  it("says the password is not saved yet, with Turn on saving… opening the chooser (#5835)", async () => {
    render();
    expect(query("field-password-not-saved")?.textContent).toContain(
      "Passwords aren't saved. This one is used only for Test and this connect."
    );
    const requestStorageChoice = vi.fn().mockResolvedValue(null);
    useAppStore.setState({ requestStorageChoice });
    await act(async () => {
      query("field-password-turn-on-saving")!.click();
    });
    expect(requestStorageChoice).toHaveBeenCalledTimes(1);
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

  it("keeps Save credentials in view: focused before the chooser opens, scrolled to after (#5630)", async () => {
    const scrolled: Element[] = [];
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this);
    };
    try {
      render();
      const toggle = query("field-savePassword")!;
      // A synthetic click (and WebKit's mouse click) does not focus the button.
      expect(document.activeElement).not.toBe(toggle);
      await toggleOn();
      // Focused before the chooser opens, so the dialog returns focus here.
      expect(document.activeElement).toBe(toggle);

      await act(async () => {
        useAppStore.getState().resolveStorageChoice("os_keychain");
      });
      await act(async () => {
        await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      });
      // The whole row — toggle and the line under it — clear of the footer (#5825).
      expect(scrolled).toContain(query("dynamic-field-savePassword"));
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });

  describe("result in place, no toast (#5825)", () => {
    const toastSpy = () => vi.spyOn(toast, "success");

    it("asks as a save, so the chooser names the dropped save on dismiss", async () => {
      render();
      await toggleOn();
      expect(useAppStore.getState().storageChooserPurpose).toBe("save");
    });

    it("names the chosen store under the toggle once it is on", async () => {
      const success = toastSpy();
      render();
      await toggleOn();
      await act(async () => {
        useAppStore.getState().resolveStorageChoice("os_keychain");
      });
      // The parent re-renders with the toggle on and the store chosen.
      render({ savePassword: true }, false);

      const toggle = query("field-savePassword")!;
      expect(toggle.getAttribute("aria-checked")).toBe("true");
      const note = query("field-savePassword-storage-chosen")!;
      expect(note.textContent).toBe("Passwords will be stored in the OS Keychain.");
      expect(toggle.getAttribute("aria-describedby")).toContain(note.id);
      expect(success).not.toHaveBeenCalled();
      success.mockRestore();
    });

    it("drops the line once the toggle is turned off again", async () => {
      render();
      await toggleOn();
      await act(async () => {
        useAppStore.getState().resolveStorageChoice("master_password");
      });
      render({ savePassword: true }, false);
      expect(query("field-savePassword-storage-chosen")!.textContent).toBe(
        "Passwords will be stored in your master-password vault."
      );
      await toggleOn(); // a click on the ticked toggle turns it off
      expect(lastSettings.savePassword).toBe(false);
      expect(query("field-savePassword-storage-chosen")).toBeNull();
    });

    it("leaves the toggle visibly off and says nothing when the chooser is dismissed", async () => {
      const success = toastSpy();
      render();
      await toggleOn();
      await act(async () => {
        useAppStore.getState().resolveStorageChoice("canceled");
      });

      expect(query("field-savePassword")!.getAttribute("aria-checked")).toBe("false");
      expect(lastSettings.savePassword).not.toBe(true);
      expect(query("field-savePassword-storage-chosen")).toBeNull();
      expect(success).not.toHaveBeenCalled();
      success.mockRestore();
    });
  });
});
