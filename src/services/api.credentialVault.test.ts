import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  exportCredentialVault,
  importCredentialVault,
  isVaultError,
  previewCredentialVaultImport,
} from "./api";

const mockedInvoke = vi.mocked(invoke);

describe("credential vault api", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exportCredentialVault sends the master password and export passphrase", async () => {
    mockedInvoke.mockResolvedValue("{}");
    await expect(exportCredentialVault("mp", "export-passphrase")).resolves.toBe("{}");
    expect(mockedInvoke).toHaveBeenCalledWith("export_credential_vault", {
      masterPassword: "mp",
      exportPassphrase: "export-passphrase",
    });
  });

  it("previewCredentialVaultImport sends the file text and passphrase", async () => {
    mockedInvoke.mockResolvedValue({ totalCount: 0 });
    await previewCredentialVaultImport("{json}", "pp");
    expect(mockedInvoke).toHaveBeenCalledWith("preview_credential_vault_import", {
      json: "{json}",
      passphrase: "pp",
    });
  });

  it("importCredentialVault sends the conflict strategy", async () => {
    mockedInvoke.mockResolvedValue({ importedCount: 1 });
    await importCredentialVault("{json}", "pp", "overwrite");
    expect(mockedInvoke).toHaveBeenCalledWith("import_credential_vault", {
      json: "{json}",
      passphrase: "pp",
      strategy: "overwrite",
    });
  });

  it("isVaultError recognises only structured vault errors", () => {
    expect(isVaultError({ kind: "wrongPassphrase", message: "m" })).toBe(true);
    expect(isVaultError({ kind: "storeLocked", message: "m" })).toBe(true);
    expect(isVaultError({ kind: "reauthUnavailable", message: "m" })).toBe(true);
    expect(isVaultError({ kind: "wrongPassword", message: "m" })).toBe(false);
    expect(isVaultError("oops")).toBe(false);
    expect(isVaultError(null)).toBe(false);
  });
});
