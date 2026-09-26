import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { open as openFileDialog, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { useAppStore } from "@/store/appStore";
import {
  CredentialVaultBackup,
  KEYCHAIN_EXPORT_CHECKING_REASON,
  KEYCHAIN_EXPORT_UNAVAILABLE_REASON,
  keychainExportReason,
} from "./CredentialVaultBackup";
import { OS_AUTH_AVAILABLE, OS_AUTH_UNAVAILABLE } from "@/test/osAuthFixtures";
import { importSummary } from "./CredentialVaultImportDialog";

vi.mock("@/services/api", async () => {
  const actual = await vi.importActual<typeof import("@/services/api")>("@/services/api");
  return {
    ...actual,
    exportCredentialVault: vi.fn(),
    getOsAuthInfo: vi.fn(),
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

import {
  exportCredentialVault,
  getOsAuthInfo,
  importCredentialVault,
  previewCredentialVaultImport,
} from "@/services/api";
import { toast } from "@/components/ui";

const mockedExport = vi.mocked(exportCredentialVault);
const mockedPreview = vi.mocked(previewCredentialVaultImport);
const mockedImport = vi.mocked(importCredentialVault);
const mockedSave = vi.mocked(save);
const mockedOpen = vi.mocked(openFileDialog);
const mockedRead = vi.mocked(readTextFile);
const mockedWrite = vi.mocked(writeTextFile);
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
  act(() => root.render(<CredentialVaultBackup modeLabel="Master Password" />));
}

/** Render and let the OS-auth capability query resolve. */
async function renderLoaded(mode: "master_password" | "os_keychain" | "none", status = "unlocked") {
  render(mode, status);
  await act(async () => {});
}

describe("CredentialVaultBackup", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
    vi.mocked(getOsAuthInfo).mockResolvedValue(OS_AUTH_UNAVAILABLE);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("disables both actions when credential storage is off", () => {
    render("none");
    expect((query("credential-vault-export-btn") as HTMLButtonElement).disabled).toBe(true);
    expect((query("credential-vault-import-btn") as HTMLButtonElement).disabled).toBe(true);
    expect(query("credential-vault-unavailable")).not.toBeNull();
  });

  it("keeps keychain export blocked (with the OS reason) when OS verification is unavailable", async () => {
    await renderLoaded("os_keychain");

    const exportBtn = query("credential-vault-export-btn") as HTMLButtonElement;
    expect(exportBtn.disabled).toBe(true);
    const blocked = query("credential-vault-export-blocked")?.textContent ?? "";
    expect(blocked).toContain(KEYCHAIN_EXPORT_UNAVAILABLE_REASON);
    expect(blocked).toContain("No supported system authentication.");

    // A click on the disabled button must not open the dialog or call the backend.
    await click("credential-vault-export-btn");
    expect(query("vault-export-title")).toBeNull();
    expect(mockedExport).not.toHaveBeenCalled();

    const importBtn = query("credential-vault-import-btn") as HTMLButtonElement;
    expect(importBtn.disabled).toBe(false);
    await click("credential-vault-import-btn");
    expect(query("vault-import-title")).not.toBeNull();
  });

  it("fails closed while the OS capability is unknown", () => {
    expect(keychainExportReason(null)).toBe(KEYCHAIN_EXPORT_CHECKING_REASON);
    expect(keychainExportReason(OS_AUTH_AVAILABLE)).toBeNull();
  });

  it("enables keychain export behind OS verification when available", async () => {
    vi.mocked(getOsAuthInfo).mockResolvedValue(OS_AUTH_AVAILABLE);
    await renderLoaded("os_keychain");

    const exportBtn = query("credential-vault-export-btn") as HTMLButtonElement;
    expect(exportBtn.disabled).toBe(false);
    expect(query("credential-vault-export-blocked")).toBeNull();
    expect(query("credential-vault-export-os-auth")?.textContent).toContain(
      "Touch ID or your Mac password"
    );

    await click("credential-vault-export-btn");
    expect(query("vault-export-os-auth-note")?.textContent).toContain("Touch ID");
    // No master password in keychain mode — the OS verifies the user instead.
    expect(query("vault-export-master-password")).toBeNull();

    mockedExport.mockResolvedValue(VAULT_JSON);
    mockedSave.mockResolvedValue("/tmp/vault.json");
    setInputValue("vault-export-passphrase", PASSPHRASE);
    setInputValue("vault-export-confirm", PASSPHRASE);
    await click("vault-export-submit");

    expect(mockedExport).toHaveBeenCalledWith(null, PASSPHRASE);
    expect(mockedWrite).toHaveBeenCalledWith("/tmp/vault.json", VAULT_JSON);
  });

  it("shows a cancelled OS verification and writes nothing", async () => {
    vi.mocked(getOsAuthInfo).mockResolvedValue(OS_AUTH_AVAILABLE);
    await renderLoaded("os_keychain");
    await click("credential-vault-export-btn");

    mockedExport.mockRejectedValue({
      kind: "reauthFailed",
      message: "System authentication was cancelled — nothing was exported.",
    });
    setInputValue("vault-export-passphrase", PASSPHRASE);
    setInputValue("vault-export-confirm", PASSPHRASE);
    await click("vault-export-submit");

    expect(query("vault-export-error")?.textContent).toMatch(/cancelled/);
    expect(mockedSave).not.toHaveBeenCalled();
    expect(mockedWrite).not.toHaveBeenCalled();
  });

  it("unlocks a locked store before opening the export dialog", async () => {
    const requestUnlock = vi.fn().mockResolvedValue(false);
    useAppStore.setState({ requestUnlock });
    render("master_password", "locked");

    await click("credential-vault-export-btn");

    expect(requestUnlock).toHaveBeenCalledTimes(1);
    // Unlock was cancelled — the dialog must not open.
    expect(query("vault-export-title")).toBeNull();
  });

  describe("export", () => {
    it("rejects mismatched passphrases without calling the backend", async () => {
      render("master_password");
      await click("credential-vault-export-btn");

      setInputValue("vault-export-master-password", "master-pw");
      setInputValue("vault-export-passphrase", PASSPHRASE);
      setInputValue("vault-export-confirm", `${PASSPHRASE}x`);
      await click("vault-export-submit");

      expect(query("vault-export-error")?.textContent).toMatch(/do not match/);
      expect(mockedExport).not.toHaveBeenCalled();
    });

    it("rejects a passphrase that equals the master password", async () => {
      render("master_password");
      await click("credential-vault-export-btn");

      setInputValue("vault-export-master-password", PASSPHRASE);
      setInputValue("vault-export-passphrase", PASSPHRASE);
      setInputValue("vault-export-confirm", PASSPHRASE);
      await click("vault-export-submit");

      expect(query("vault-export-error")?.textContent).toMatch(/different from your master/);
      expect(mockedExport).not.toHaveBeenCalled();
    });

    it("shows a strength hint while typing", async () => {
      render("master_password");
      await click("credential-vault-export-btn");

      setInputValue("vault-export-passphrase", "short");
      expect(query("vault-export-strength")?.getAttribute("data-strength")).toBe("tooShort");

      setInputValue("vault-export-passphrase", PASSPHRASE);
      expect(query("vault-export-strength")?.getAttribute("data-strength")).toBe("strong");
    });

    it("re-authenticates, encrypts and writes only the sealed file", async () => {
      mockedExport.mockResolvedValue(VAULT_JSON);
      mockedSave.mockResolvedValue("/backups/vault.json");
      render("master_password");
      await click("credential-vault-export-btn");

      setInputValue("vault-export-master-password", "master-pw");
      setInputValue("vault-export-passphrase", PASSPHRASE);
      setInputValue("vault-export-confirm", PASSPHRASE);
      await click("vault-export-submit");

      expect(mockedExport).toHaveBeenCalledWith("master-pw", PASSPHRASE);
      expect(mockedWrite).toHaveBeenCalledWith("/backups/vault.json", VAULT_JSON);
      expect(mockedToast.success).toHaveBeenCalled();
      // The dialog closes after a successful export.
      expect(query("vault-export-title")).toBeNull();
    });

    it("writes nothing when the save dialog is cancelled", async () => {
      mockedExport.mockResolvedValue(VAULT_JSON);
      mockedSave.mockResolvedValue(null);
      render("master_password");
      await click("credential-vault-export-btn");

      setInputValue("vault-export-master-password", "master-pw");
      setInputValue("vault-export-passphrase", PASSPHRASE);
      setInputValue("vault-export-confirm", PASSPHRASE);
      await click("vault-export-submit");

      expect(mockedExport).toHaveBeenCalledWith("master-pw", PASSPHRASE);
      expect(mockedWrite).not.toHaveBeenCalled();
      expect(mockedToast.info).toHaveBeenCalled();
    });

    it("surfaces a wrong master password inline", async () => {
      mockedExport.mockRejectedValue({
        kind: "wrongMasterPassword",
        message: "The master password is incorrect.",
      });
      render("master_password");
      await click("credential-vault-export-btn");

      setInputValue("vault-export-master-password", "nope");
      setInputValue("vault-export-passphrase", PASSPHRASE);
      setInputValue("vault-export-confirm", PASSPHRASE);
      await click("vault-export-submit");

      expect(query("vault-export-error")?.textContent).toBe("The master password is incorrect.");
      expect(mockedSave).not.toHaveBeenCalled();
    });
  });

  describe("import", () => {
    async function openAndPickFile() {
      mockedOpen.mockResolvedValue("/backups/vault.json");
      mockedRead.mockResolvedValue(VAULT_JSON);
      render("master_password");
      await click("credential-vault-import-btn");
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

  it("summarizes an import result", () => {
    expect(
      importSummary({ importedCount: 2, overwrittenCount: 0, skippedCount: 1, unchangedCount: 0 })
    ).toBe("Credential vault imported: 2 credentials imported, 1 kept as-is.");
  });
});
