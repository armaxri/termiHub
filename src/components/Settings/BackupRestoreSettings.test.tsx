import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { open as openFileDialog, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { useAppStore } from "@/store/appStore";
import type { BackupRestorePreview, BackupSectionInfo, BackupSectionPreview } from "@/types/backup";
import { BackupRestoreSettings } from "./BackupRestoreSettings";
import { credentialsExportBlockedReason, validateBackupExport } from "./BackupExportDialog";
import { buildRestoreRequest, defaultChoices } from "./BackupRestoreDialog";
import { sectionSummary } from "./BackupSectionRow";
import { KEYCHAIN_EXPORT_BLOCKED_REASON } from "./CredentialVaultBackup";

vi.mock("@/services/api", async () => {
  const actual = await vi.importActual<typeof import("@/services/api")>("@/services/api");
  return {
    ...actual,
    listBackupSections: vi.fn(),
    exportBackup: vi.fn(),
    readBackupHeader: vi.fn(),
    previewBackupRestore: vi.fn(),
    applyBackupRestore: vi.fn(),
    restartAfterBackupRestore: vi.fn(),
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
  applyBackupRestore,
  exportBackup,
  listBackupSections,
  previewBackupRestore,
  readBackupHeader,
  restartAfterBackupRestore,
} from "@/services/api";

const PASSPHRASE = "correct horse battery staple";
const BACKUP_JSON = '{"format":"termihub-backup"}';

const SECTIONS: BackupSectionInfo[] = [
  {
    id: "connections",
    label: "Connections",
    description: "Saved connections",
    containsSecrets: false,
    present: true,
    itemCount: 3,
  },
  {
    id: "embeddedServers",
    label: "Embedded servers",
    description: "Servers",
    containsSecrets: true,
    present: true,
    itemCount: 1,
  },
  {
    id: "tunnels",
    label: "Tunnels",
    description: "Tunnels",
    containsSecrets: false,
    present: false,
    itemCount: 0,
  },
];

function sectionPreview(overrides: Partial<BackupSectionPreview>): BackupSectionPreview {
  return {
    id: "macros",
    label: "Macros",
    status: "ok",
    message: null,
    schemaVersion: 1,
    supportedVersion: 1,
    supportsMerge: true,
    itemCount: 2,
    currentCount: 1,
    newCount: 1,
    conflictCount: 1,
    unchangedCount: 0,
    ...overrides,
  };
}

const PREVIEW: BackupRestorePreview = {
  createdAt: "2026-09-26T00:00:00Z",
  appVersion: "0.1.0",
  encrypted: true,
  sections: [
    sectionPreview({}),
    sectionPreview({ id: "settings", label: "Settings", supportsMerge: false }),
    sectionPreview({
      id: "workflows",
      label: "Workflows",
      status: "newer",
      message: "Workflows was backed up by a newer version of termiHub.",
    }),
  ],
  credentials: {
    available: true,
    unavailableReason: null,
    preview: {
      createdAt: "t",
      targetMode: "master_password",
      totalCount: 2,
      newCount: 2,
      unchangedCount: 0,
      conflictCount: 0,
      conflicts: [],
      unknownOwnerCount: 0,
    },
  },
};

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

function isChecked(testId: string): boolean {
  return query(testId)?.getAttribute("aria-checked") === "true";
}

function render(mode: "master_password" | "os_keychain" | "none", status = "unlocked") {
  useAppStore.setState({
    credentialStoreStatus: {
      mode,
      status: status as "unlocked" | "locked" | "unavailable",
    },
  });
  act(() => root.render(<BackupRestoreSettings />));
}

async function openExport() {
  await click("backup-export-btn");
  await act(async () => {});
}

describe("backup export helpers", () => {
  it("explains why credentials cannot be included", () => {
    expect(credentialsExportBlockedReason("os_keychain", "unlocked")).toBe(
      KEYCHAIN_EXPORT_BLOCKED_REASON
    );
    expect(credentialsExportBlockedReason("none", undefined)).toMatch(/off/);
    expect(credentialsExportBlockedReason("master_password", "unavailable")).toMatch(/master/);
    expect(credentialsExportBlockedReason("master_password", "locked")).toBeNull();
  });

  it("validates the export form", () => {
    const base = {
      mode: "master_password" as const,
      selected: new Set(["connections"]),
      includeCredentials: false,
      encrypt: true,
      masterPassword: "",
      passphrase: PASSPHRASE,
      confirm: PASSPHRASE,
    };
    expect(validateBackupExport(base)).toBeNull();
    expect(validateBackupExport({ ...base, selected: new Set() })).toMatch(/at least one/);
    expect(validateBackupExport({ ...base, passphrase: "short", confirm: "short" })).toMatch(
      /12 characters/
    );
    expect(validateBackupExport({ ...base, confirm: "different passphrase" })).toMatch(
      /do not match/
    );
    expect(validateBackupExport({ ...base, includeCredentials: true })).toMatch(/master password/);
    expect(
      validateBackupExport({
        ...base,
        includeCredentials: true,
        masterPassword: PASSPHRASE,
      })
    ).toMatch(/different from your master password/);
    // No passphrase needed for an unencrypted backup without credentials.
    expect(
      validateBackupExport({ ...base, encrypt: false, passphrase: "", confirm: "" })
    ).toBeNull();
  });
});

describe("backup restore helpers", () => {
  it("defaults to merging restorable sections and skips unrestorable ones", () => {
    const choices = defaultChoices(PREVIEW);
    expect(choices.macros).toEqual({ include: true, mode: "merge", conflicts: "skip" });
    expect(choices.settings.mode).toBe("replace");
    expect(choices.workflows.include).toBe(false);

    const request = buildRestoreRequest(PREVIEW, choices, "overwrite");
    expect(request).toEqual({
      sections: [
        { id: "macros", mode: "merge", conflicts: "skip" },
        { id: "settings", mode: "replace", conflicts: "skip" },
      ],
      credentials: "overwrite",
    });
  });

  it("never requests an unrestorable section even if marked included", () => {
    const choices = defaultChoices(PREVIEW);
    choices.workflows.include = true;
    const ids = buildRestoreRequest(PREVIEW, choices, null).sections.map((s) => s.id);
    expect(ids).not.toContain("workflows");
  });

  it("summarizes a section's items", () => {
    expect(sectionSummary(sectionPreview({}))).toBe("2 in backup · 1 new · 1 differ");
    expect(sectionSummary(sectionPreview({ id: "settings" }))).toMatch(/Replaces/);
  });
});

describe("BackupRestoreSettings", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
    vi.mocked(listBackupSections).mockResolvedValue(SECTIONS);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("blocks the credentials section in keychain mode but backs up the rest", async () => {
    render("os_keychain");
    await openExport();

    expect(isChecked("backup-export-credentials")).toBe(false);
    expect((query("backup-export-credentials") as HTMLButtonElement).disabled).toBe(true);
    expect(query("backup-export-credentials-detail")?.textContent).toBe(
      KEYCHAIN_EXPORT_BLOCKED_REASON
    );
    // Present sections are preselected; a store with nothing saved is not.
    expect(isChecked("backup-export-section-connections")).toBe(true);
    expect(isChecked("backup-export-section-tunnels")).toBe(false);

    vi.mocked(exportBackup).mockResolvedValue({
      json: BACKUP_JSON,
      sections: ["connections", "embeddedServers"],
      credentialCount: null,
    });
    vi.mocked(save).mockResolvedValue("/tmp/backup.json");
    setInputValue("backup-export-passphrase", PASSPHRASE);
    setInputValue("backup-export-confirm", PASSPHRASE);
    await click("backup-export-submit");

    expect(exportBackup).toHaveBeenCalledWith(
      {
        sections: ["connections", "embeddedServers"],
        includeCredentials: false,
        encrypt: true,
      },
      PASSPHRASE,
      null
    );
    expect(writeTextFile).toHaveBeenCalledWith("/tmp/backup.json", BACKUP_JSON);
  });

  it("includes credentials in master-password mode and requires re-authentication", async () => {
    render("master_password");
    await openExport();
    expect(isChecked("backup-export-credentials")).toBe(true);

    setInputValue("backup-export-passphrase", PASSPHRASE);
    setInputValue("backup-export-confirm", PASSPHRASE);
    await click("backup-export-submit");
    expect(query("backup-export-error")?.textContent).toMatch(/master password/);
    expect(exportBackup).not.toHaveBeenCalled();

    vi.mocked(exportBackup).mockResolvedValue({
      json: BACKUP_JSON,
      sections: ["connections"],
      credentialCount: 4,
    });
    vi.mocked(save).mockResolvedValue(null);
    setInputValue("backup-export-master-password", "master-pw");
    await click("backup-export-submit");
    expect(vi.mocked(exportBackup).mock.calls[0][0].includeCredentials).toBe(true);
    expect(vi.mocked(exportBackup).mock.calls[0][2]).toBe("master-pw");
    // Cancelling the save dialog writes nothing.
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it("turning encryption off drops secret-bearing sections and warns", async () => {
    render("none");
    await openExport();
    expect(isChecked("backup-export-section-embeddedServers")).toBe(true);

    await click("backup-export-encrypt");
    expect(isChecked("backup-export-section-embeddedServers")).toBe(false);
    expect((query("backup-export-section-embeddedServers") as HTMLButtonElement).disabled).toBe(
      true
    );
    expect(query("backup-export-plain-warning")).not.toBeNull();
    expect(query("backup-export-passphrase")).toBeNull();
  });

  it("previews, restores the chosen parts and restarts", async () => {
    render("master_password");
    vi.mocked(openFileDialog).mockResolvedValue("/tmp/backup.json");
    vi.mocked(readTextFile).mockResolvedValue(BACKUP_JSON);
    vi.mocked(readBackupHeader).mockResolvedValue({
      createdAt: "2026-09-26T00:00:00Z",
      appVersion: "0.1.0",
      encrypted: true,
      needsPassphrase: true,
    });
    vi.mocked(previewBackupRestore).mockResolvedValue(PREVIEW);
    vi.mocked(applyBackupRestore).mockResolvedValue({
      sections: [],
      credentials: null,
      restartRequired: true,
    });

    await click("backup-restore-btn");
    await click("backup-restore-choose-file");
    expect(query("backup-restore-file-name")?.textContent).toBe("backup.json");
    setInputValue("backup-restore-passphrase", PASSPHRASE);
    await click("backup-restore-preview");
    expect(previewBackupRestore).toHaveBeenCalledWith(BACKUP_JSON, PASSPHRASE);

    // The newer section cannot be chosen; replacing settings is warned about.
    expect((query("backup-restore-include-workflows") as HTMLButtonElement).disabled).toBe(true);
    expect(query("backup-restore-replace-warning")?.textContent).toMatch(/Settings/);
    expect(isChecked("backup-restore-include-credentials")).toBe(true);

    // Leave macros out.
    await click("backup-restore-include-macros");
    await click("backup-restore-submit");

    expect(applyBackupRestore).toHaveBeenCalledWith(BACKUP_JSON, PASSPHRASE, {
      sections: [{ id: "settings", mode: "replace", conflicts: "skip" }],
      credentials: "skip",
    });
    expect(restartAfterBackupRestore).toHaveBeenCalled();
  });

  it("shows why a backup file cannot be read", async () => {
    render("none");
    vi.mocked(openFileDialog).mockResolvedValue("/tmp/other.json");
    vi.mocked(readTextFile).mockResolvedValue("{}");
    vi.mocked(readBackupHeader).mockRejectedValue({
      kind: "invalidFile",
      message: "The file is not a termiHub backup.",
    });
    await click("backup-restore-btn");
    await click("backup-restore-choose-file");
    expect(query("backup-restore-error")?.textContent).toBe("The file is not a termiHub backup.");
    expect((query("backup-restore-preview") as HTMLButtonElement).disabled).toBe(true);
  });
});
