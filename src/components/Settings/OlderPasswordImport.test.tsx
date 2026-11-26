import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { useAppStore } from "@/store/appStore";
import { OlderPasswordImport } from "./OlderPasswordImport";
import {
  KEYCHAIN_EXPORT_CHECKING_REASON,
  KEYCHAIN_EXPORT_UNAVAILABLE_REASON,
  keychainExportReason,
} from "./keychainExport";
import { OS_AUTH_AVAILABLE } from "@/test/osAuthFixtures";
import { importSummary } from "./CredentialVaultImportDialog";

vi.mock("@/services/api", async () => {
  const actual = await vi.importActual<typeof import("@/services/api")>("@/services/api");
  return {
    ...actual,
    previewCredentialVaultImport: vi.fn(),
    importCredentialVault: vi.fn(),
  };
});

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return {
    ...actual,
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  };
});

import { importCredentialVault, previewCredentialVaultImport } from "@/services/api";
import { toast } from "@/components/ui";

const mockedPreview = vi.mocked(previewCredentialVaultImport);
const mockedImport = vi.mocked(importCredentialVault);
const mockedOpen = vi.mocked(openFileDialog);
const mockedRead = vi.mocked(readTextFile);
const mockedToast = vi.mocked(toast);

const PASSPHRASE = "correct horse battery staple";
const VAULT_JSON = '{"format":"termihub-credential-vault","formatVersion":1}';

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

function setInputValue(testId: string, value: string) {
  const input = query(testId) as HTMLInputElement;
  act(() => {
    input.focus();
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
      input,
      value
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(testId: string) {
  await act(async () => {
    query(testId)!.click();
  });
}

function render(mode: "master_password" | "os_keychain" | "none", status = "unlocked") {
  useAppStore.setState({
    credentialStoreStatus: {
      mode,
      status: status as "unlocked" | "locked" | "unavailable",
    },
  });
  act(() => root.render(<OlderPasswordImport />));
}

describe("OlderPasswordImport (#5860)", () => {
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
  });

  it("says why nothing can be restored while passwords are not saved", () => {
    render("none");
    expect(query("older-password-import-btn")).toBeNull();
    expect(query("older-password-import-unavailable")?.textContent).toMatch(
      /^Credential storage is off, so credentials won't be restored\./
    );
  });

  it("asks for a master password before one is set", () => {
    render("master_password", "unavailable");
    expect(query("older-password-import-btn")).toBeNull();
    expect(query("older-password-import-unavailable")?.textContent).toBe(
      "Set up a master password first."
    );
  });

  it("opens the restore in OS Keychain mode, without the word vault", async () => {
    render("os_keychain");
    await click("older-password-import-btn");
    expect(query("vault-import-title")?.textContent).toBe("Restore passwords from an older export");
    const dialog = query("vault-import-title")!.closest("[role='dialog']")!;
    expect(dialog.textContent).toContain("OS Keychain");
    expect(dialog.textContent?.toLowerCase()).not.toContain("vault");
  });

  it("unlocks a locked store first, and opens nothing when that is cancelled", async () => {
    const requestUnlock = vi.fn().mockResolvedValue(false);
    useAppStore.setState({ requestUnlock });
    render("master_password", "locked");
    await click("older-password-import-btn");
    expect(requestUnlock).toHaveBeenCalledTimes(1);
    expect(query("vault-import-title")).toBeNull();
  });

  describe("import", () => {
    async function openAndPickFile() {
      mockedOpen.mockResolvedValue("/backups/vault.json");
      mockedRead.mockResolvedValue(VAULT_JSON);
      render("master_password");
      await click("older-password-import-btn");
      await click("vault-import-choose-file");
      setInputValue("vault-import-passphrase", PASSPHRASE);
    }

    it("shows a clear error for a wrong passphrase and imports nothing", async () => {
      mockedPreview.mockRejectedValue({
        kind: "wrongPassphrase",
        message: "Wrong passphrase, or the file has been modified or corrupted.",
      });
      await openAndPickFile();

      await click("vault-import-preview");

      expect(query("vault-import-error")?.textContent).toMatch(/Wrong passphrase/);
      expect(query("vault-import-preview-panel")).toBeNull();
      expect(mockedImport).not.toHaveBeenCalled();
    });

    it("previews conflicts and imports with the chosen strategy", async () => {
      mockedPreview.mockResolvedValue({
        createdAt: "2026-09-26T00:00:00Z",
        targetMode: "master_password",
        totalCount: 3,
        newCount: 1,
        unchangedCount: 1,
        conflictCount: 1,
        conflicts: [{ connectionId: "c1", credentialType: "password", ownerName: "Prod DB" }],
        unknownOwnerCount: 0,
      });
      mockedImport.mockResolvedValue({
        importedCount: 1,
        overwrittenCount: 1,
        skippedCount: 0,
        unchangedCount: 1,
      });
      await openAndPickFile();
      expect(query("vault-import-file-name")?.textContent).toBe("vault.json");

      await click("vault-import-preview");

      expect(mockedPreview).toHaveBeenCalledWith(VAULT_JSON, PASSPHRASE);
      expect(query("vault-import-conflicts")?.textContent).toContain("Prod DB — Password");
      expect(mockedImport).not.toHaveBeenCalled();

      await click("vault-import-strategy-overwrite");
      expect(query("vault-import-overwrite-warning")).not.toBeNull();
      await click("vault-import-submit");

      expect(mockedImport).toHaveBeenCalledWith(VAULT_JSON, PASSPHRASE, "overwrite");
      expect(mockedToast.success).toHaveBeenCalled();
    });
  });

  it("summarizes a restore", () => {
    expect(
      importSummary({ importedCount: 2, overwrittenCount: 0, skippedCount: 1, unchangedCount: 0 })
    ).toBe("Passwords restored: 2 credentials imported, 1 kept as-is.");
  });
});

describe("keychainExportReason", () => {
  it("names the OS Keychain with the chooser's casing", () => {
    expect(KEYCHAIN_EXPORT_UNAVAILABLE_REASON).toContain("OS Keychain");
  });

  it("fails closed while the OS capability is unknown", () => {
    expect(keychainExportReason(null)).toBe(KEYCHAIN_EXPORT_CHECKING_REASON);
    expect(keychainExportReason(OS_AUTH_AVAILABLE)).toBeNull();
  });
});
