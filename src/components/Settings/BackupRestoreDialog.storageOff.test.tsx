/**
 * Restoring a backup while credential storage is off (#5631): the dialog says
 * the credentials will not be restored, offers to set up storage in place and
 * re-enables the credentials once a store exists; the primary action is the
 * plain filled primary (never the Preview button's lingering success state).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { useAppStore } from "@/store/appStore";
import type { BackupRestorePreview, BackupSectionPreview } from "@/types/backup";
import { BackupRestoreDialog } from "./BackupRestoreDialog";

vi.mock("@/services/api", async () => {
  const actual = await vi.importActual<typeof import("@/services/api")>("@/services/api");
  return {
    ...actual,
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

import { previewBackupRestore, readBackupHeader } from "@/services/api";

const PASSPHRASE = "correct horse battery staple";
const BACKUP_JSON = '{"format":"termihub-backup"}';
const OFF_REASON =
  "Credential storage is turned off. Choose OS Keychain or Master password first, then " +
  "import the vault.";

function section(overrides: Partial<BackupSectionPreview>): BackupSectionPreview {
  return {
    id: "connections",
    label: "Connections",
    status: "ok",
    message: null,
    schemaVersion: 1,
    supportedVersion: 1,
    supportsMerge: true,
    itemCount: 2,
    currentCount: 0,
    newCount: 2,
    conflictCount: 0,
    unchangedCount: 0,
    conflictsKeepExisting: false,
    notes: [],
    ...overrides,
  };
}

const SECTIONS = [
  section({}),
  section({ id: "settings", label: "Settings", supportsMerge: false }),
];

const OFF_PREVIEW: BackupRestorePreview = {
  createdAt: "2026-11-13T00:00:00Z",
  appVersion: "0.1.0",
  encrypted: true,
  sections: SECTIONS,
  credentials: { available: false, unavailableReason: OFF_REASON, preview: null },
};

const ON_PREVIEW: BackupRestorePreview = {
  ...OFF_PREVIEW,
  credentials: {
    available: true,
    unavailableReason: null,
    preview: {
      createdAt: "t",
      targetMode: "master_password",
      totalCount: 1,
      newCount: 1,
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

/** Open the dialog with storage off and step through to the preview. */
async function openPreview() {
  useAppStore.setState({
    credentialStoreStatus: { mode: "none", status: "unavailable", storageChosen: true },
  });
  act(() => root.render(<BackupRestoreDialog open onOpenChange={() => {}} />));
  await click("backup-restore-choose-file");
  setInputValue("backup-restore-passphrase", PASSPHRASE);
  await click("backup-restore-preview");
}

describe("BackupRestoreDialog with credential storage off (#5631)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
    vi.mocked(openFileDialog).mockResolvedValue("/tmp/backup.json");
    vi.mocked(readTextFile).mockResolvedValue(BACKUP_JSON);
    vi.mocked(readBackupHeader).mockResolvedValue({
      createdAt: "2026-11-13T00:00:00Z",
      appVersion: "0.1.0",
      encrypted: true,
      needsPassphrase: true,
    });
    vi.mocked(previewBackupRestore).mockResolvedValue(OFF_PREVIEW);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("says plainly that credentials will not be restored and why", async () => {
    await openPreview();
    const detail = query("backup-restore-credentials-detail")?.textContent ?? "";
    expect(detail).toMatch(/credentials won't be restored/i);
    expect(detail).toMatch(/OS Keychain or Master password/);
    expect(detail).not.toMatch(/Master Password/);
    expect((query("backup-restore-include-credentials") as HTMLButtonElement).disabled).toBe(true);
    expect(query("backup-restore-credentials-skipped")?.textContent).toBe(
      "Credentials will not be restored."
    );
  });

  it("offers to set up storage in place and then re-enables the credentials", async () => {
    await openPreview();
    expect(query("backup-restore-setup-storage")?.textContent).toBe("Set up storage…");
    vi.mocked(previewBackupRestore).mockResolvedValue(ON_PREVIEW);

    await click("backup-restore-setup-storage");
    expect(useAppStore.getState().storageChooserOpen).toBe(true);
    await act(async () => {
      useAppStore.getState().resolveStorageChoice("master_password");
    });

    expect(previewBackupRestore).toHaveBeenCalledTimes(2);
    expect(previewBackupRestore).toHaveBeenLastCalledWith(BACKUP_JSON, PASSPHRASE);
    expect(isChecked("backup-restore-include-credentials")).toBe(true);
    expect(query("backup-restore-setup-storage")).toBeNull();
    expect(query("backup-restore-credentials-skipped")).toBeNull();
    // The other choices survive the refresh.
    expect(isChecked("backup-restore-include-connections")).toBe(true);
  });

  it("keeps credentials off when the storage chooser is canceled", async () => {
    await openPreview();
    await click("backup-restore-setup-storage");
    await act(async () => {
      useAppStore.getState().resolveStorageChoice("canceled");
    });
    expect(previewBackupRestore).toHaveBeenCalledTimes(1);
    expect(query("backup-restore-credentials-skipped")).not.toBeNull();
  });

  it("does not offer storage setup when the store is merely locked", async () => {
    vi.mocked(previewBackupRestore).mockResolvedValue({
      ...OFF_PREVIEW,
      credentials: {
        available: false,
        unavailableReason: "Unlock the credential store before importing into it.",
        preview: null,
      },
    });
    await openPreview();
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "locked" },
    });
    await act(async () => {});
    expect(query("backup-restore-setup-storage")).toBeNull();
    expect(query("backup-restore-credentials-detail")?.textContent).toMatch(/Unlock/);
    expect(query("backup-restore-credentials-skipped")).not.toBeNull();
  });

  it("shows Restore as a plain filled primary, not the Preview button's success state", async () => {
    await openPreview();
    const submit = query("backup-restore-submit")!;
    expect(submit.className).toMatch(/ui-btn--primary/);
    expect(submit.className).not.toMatch(/ui-btn--success/);
  });

  it("words the replace warning in sentence case", async () => {
    await openPreview();
    expect(query("backup-restore-replace-warning")?.textContent).toMatch(
      /^Replace overwrites your current settings:/
    );
  });
});
