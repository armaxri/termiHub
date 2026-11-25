import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { open as openFileDialog, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { useAppStore } from "@/store/appStore";
import type { BackupRestorePreview, BackupSectionInfo, BackupSectionPreview } from "@/types/backup";
import { BackupSwitchedOff } from "./BackupSwitchedOff";
import { BackupRestoreSettings, restoredOffText } from "./BackupRestoreSettings";
import { credentialsExportBlockedReason, validateBackupExport } from "./BackupExportDialog";
import { buildRestoreRequest, defaultChoices } from "./BackupRestoreDialog";
import { sectionSummary } from "./BackupSectionRow";
import { KEYCHAIN_EXPORT_UNAVAILABLE_REASON } from "./CredentialVaultBackup";
import { OS_AUTH_AVAILABLE, OS_AUTH_UNAVAILABLE } from "@/test/osAuthFixtures";

vi.mock("@/services/api", async () => {
  const actual = await vi.importActual<typeof import("@/services/api")>("@/services/api");
  return {
    ...actual,
    listBackupSections: vi.fn(),
    exportBackup: vi.fn(),
    getOsAuthInfo: vi.fn(),
    readBackupHeader: vi.fn(),
    previewBackupRestore: vi.fn(),
    applyBackupRestore: vi.fn(),
    restartAfterBackupRestore: vi.fn(),
    listRestoredOff: vi.fn(),
    dismissRestoredOff: vi.fn(),
  };
});

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return {
    ...actual,
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  };
});

import { toast } from "@/components/ui";
import {
  applyBackupRestore,
  exportBackup,
  getOsAuthInfo,
  listBackupSections,
  listRestoredOff,
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
    requiresEncryption: false,
    present: true,
    itemCount: 3,
  },
  {
    id: "embeddedServers",
    label: "Embedded servers",
    description: "Servers",
    containsSecrets: true,
    requiresEncryption: true,
    present: true,
    itemCount: 1,
  },
  {
    id: "tunnels",
    label: "Tunnels",
    description: "Tunnels",
    containsSecrets: false,
    requiresEncryption: false,
    present: false,
    itemCount: 0,
  },
  {
    id: "sshKnownHosts",
    label: "Trusted SSH host keys",
    description: "Host keys",
    containsSecrets: false,
    requiresEncryption: true,
    present: true,
    itemCount: 2,
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
    conflictsKeepExisting: false,
    notes: [],
    ...overrides,
  };
}

const PREVIEW: BackupRestorePreview = {
  createdAt: "2026-09-26T00:00:00Z",
  appVersion: "0.1.0",
  encrypted: true,
  switchedOff: [],
  sections: [
    sectionPreview({}),
    sectionPreview({ id: "settings", label: "Settings", supportsMerge: false }),
    sectionPreview({
      id: "workflows",
      label: "Workflows",
      status: "newer",
      message: "Workflows was backed up by a newer version of termiHub.",
    }),
    sectionPreview({
      id: "sshKnownHosts",
      label: "Trusted SSH host keys",
      conflictsKeepExisting: true,
      notes: ["1 host is already trusted here with a different key: a:22."],
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

/** Step 1 → step 2 of the backup dialog (#5847). */
async function toPassphraseStep() {
  await click("backup-export-next");
}

describe("backup export helpers", () => {
  it("explains why credentials cannot be included", () => {
    expect(
      credentialsExportBlockedReason("os_keychain", "unlocked", OS_AUTH_UNAVAILABLE)
    ).toContain(KEYCHAIN_EXPORT_UNAVAILABLE_REASON);
    // Unknown capability fails closed; available OS verification unblocks it.
    expect(credentialsExportBlockedReason("os_keychain", "unlocked", null)).not.toBeNull();
    expect(credentialsExportBlockedReason("os_keychain", "unlocked", OS_AUTH_AVAILABLE)).toBeNull();
    expect(credentialsExportBlockedReason("none", undefined, null)).toMatch(/off/);
    expect(credentialsExportBlockedReason("master_password", "unavailable", null)).toMatch(
      /master/
    );
    expect(credentialsExportBlockedReason("master_password", "locked", null)).toBeNull();
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
    expect(choices.workflows.include).toBe(false);

    const request = buildRestoreRequest(PREVIEW, choices, "overwrite");
    expect(request).toEqual({
      sections: [
        { id: "macros", mode: "merge", conflicts: "skip" },
        { id: "sshKnownHosts", mode: "merge", conflicts: "skip" },
      ],
      credentials: "overwrite",
    });
  });

  it("never defaults to Replace: a section that cannot merge is not included (#5824)", () => {
    const choices = defaultChoices(PREVIEW);
    expect(choices.settings).toEqual({ include: false, mode: "replace", conflicts: "skip" });
    for (const s of PREVIEW.sections) {
      const c = choices[s.id];
      expect(c.include && c.mode === "replace").toBe(false);
      if (s.supportsMerge) expect(c.mode).toBe("merge");
    }
  });

  it("requests Replace only once the user ticks the section (#5824)", () => {
    const choices = defaultChoices(PREVIEW);
    choices.settings.include = true;
    const ids = buildRestoreRequest(PREVIEW, choices, null).sections;
    expect(ids).toContainEqual({ id: "settings", mode: "replace", conflicts: "skip" });
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
    expect(sectionSummary(sectionPreview({ id: "settings" }), false)).toBe(
      "Not included · replace only, no merge"
    );
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
    vi.mocked(getOsAuthInfo).mockResolvedValue(OS_AUTH_UNAVAILABLE);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("includes keychain credentials behind OS verification when available", async () => {
    vi.mocked(getOsAuthInfo).mockResolvedValue(OS_AUTH_AVAILABLE);
    render("os_keychain");
    await openExport();

    expect(isChecked("backup-export-credentials")).toBe(true);
    expect((query("backup-export-credentials") as HTMLButtonElement).disabled).toBe(false);
    expect(query("backup-export-credentials-detail")?.textContent).toContain("Touch ID");
    // The OS verifies the user — no master password field in keychain mode.
    expect(query("backup-export-master-password")).toBeNull();

    vi.mocked(exportBackup).mockResolvedValue({
      json: BACKUP_JSON,
      sections: ["connections"],
      credentialCount: 2,
      warnings: [],
    });
    vi.mocked(save).mockResolvedValue("/tmp/backup.json");
    await toPassphraseStep();
    // The OS verifies the user: no master password step either.
    expect(query("backup-export-step")?.textContent).toBe("Step 2 of 2 · Backup passphrase");
    setInputValue("backup-export-passphrase", PASSPHRASE);
    setInputValue("backup-export-confirm", PASSPHRASE);
    await click("backup-export-submit");

    expect(exportBackup).toHaveBeenCalledWith(
      expect.objectContaining({ includeCredentials: true }),
      PASSPHRASE,
      null
    );
  });

  it("blocks the credentials section in keychain mode but backs up the rest", async () => {
    render("os_keychain");
    await openExport();

    expect(isChecked("backup-export-credentials")).toBe(false);
    expect((query("backup-export-credentials") as HTMLButtonElement).disabled).toBe(true);
    expect(query("backup-export-credentials-detail")?.textContent).toContain(
      KEYCHAIN_EXPORT_UNAVAILABLE_REASON
    );
    // Present sections are preselected; a store with nothing saved is not.
    expect(isChecked("backup-export-section-connections")).toBe(true);
    expect(isChecked("backup-export-section-tunnels")).toBe(false);

    vi.mocked(exportBackup).mockResolvedValue({
      json: BACKUP_JSON,
      sections: ["connections", "embeddedServers"],
      credentialCount: null,
      warnings: [],
    });
    vi.mocked(save).mockResolvedValue("/tmp/backup.json");
    await toPassphraseStep();
    setInputValue("backup-export-passphrase", PASSPHRASE);
    setInputValue("backup-export-confirm", PASSPHRASE);
    await click("backup-export-submit");

    expect(exportBackup).toHaveBeenCalledWith(
      {
        sections: ["connections", "embeddedServers", "sshKnownHosts"],
        includeCredentials: false,
        encrypt: true,
      },
      PASSPHRASE,
      null
    );
    expect(writeTextFile).toHaveBeenCalledWith("/tmp/backup.json", BACKUP_JSON);
    expect(toast.success).toHaveBeenCalled();
  });

  it("tells the user what an export left out", async () => {
    render("none");
    await openExport();
    vi.mocked(exportBackup).mockResolvedValue({
      json: BACKUP_JSON,
      sections: ["plugins"],
      credentialCount: null,
      warnings: ['Plugin "huge" was not included because it is too large.'],
    });
    vi.mocked(save).mockResolvedValue("/tmp/backup.json");
    await toPassphraseStep();
    setInputValue("backup-export-passphrase", PASSPHRASE);
    setInputValue("backup-export-confirm", PASSPHRASE);
    await click("backup-export-submit");
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith(
      expect.stringMatching(/left out/),
      expect.objectContaining({ description: expect.stringMatching(/"huge"/) })
    );
  });

  it("includes credentials in master-password mode and requires re-authentication", async () => {
    render("master_password");
    await openExport();
    expect(isChecked("backup-export-credentials")).toBe(true);

    await toPassphraseStep();
    setInputValue("backup-export-passphrase", PASSPHRASE);
    setInputValue("backup-export-confirm", PASSPHRASE);
    await click("backup-export-next");
    await click("backup-export-submit");
    expect(query("backup-export-error")?.textContent).toMatch(/master password/);
    expect(exportBackup).not.toHaveBeenCalled();

    vi.mocked(exportBackup).mockResolvedValue({
      json: BACKUP_JSON,
      sections: ["connections"],
      credentialCount: 4,
      warnings: [],
    });
    vi.mocked(save).mockResolvedValue(null);
    setInputValue("backup-export-master-password", "master-pw");
    await click("backup-export-submit");
    expect(vi.mocked(exportBackup).mock.calls[0][0].includeCredentials).toBe(true);
    expect(vi.mocked(exportBackup).mock.calls[0][2]).toBe("master-pw");
    // Cancelling the save dialog writes nothing.
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it("a backup without a passphrase needs the locked-only parts left out, and warns", async () => {
    render("none");
    await openExport();
    expect(isChecked("backup-export-section-embeddedServers")).toBe(true);

    await toPassphraseStep();
    expect((query("backup-export-plain") as HTMLButtonElement).disabled).toBe(true);
    expect(query("backup-export-plain-detail")?.textContent).toBe(
      "Not possible while the backup includes embedded servers and trusted SSH host keys."
    );

    await click("backup-export-back");
    await click("backup-export-section-embeddedServers");
    await click("backup-export-section-sshKnownHosts");
    await toPassphraseStep();
    await click("backup-export-plain");
    expect(query("backup-export-plain-warning")).not.toBeNull();
    expect(query("backup-export-passphrase")).toBeNull();

    // Ticking a locked-only part again turns the passphrase back on.
    await click("backup-export-back");
    await click("backup-export-section-sshKnownHosts");
    await toPassphraseStep();
    expect(isChecked("backup-export-plain")).toBe(false);
    expect(query("backup-export-passphrase")).not.toBeNull();
  });

  it("says what arrives switched off, as the parts are chosen (#6056)", async () => {
    render("master_password");
    vi.mocked(openFileDialog).mockResolvedValue("/tmp/backup.json");
    vi.mocked(readTextFile).mockResolvedValue(BACKUP_JSON);
    vi.mocked(readBackupHeader).mockResolvedValue({
      createdAt: "2026-09-26T00:00:00Z",
      appVersion: "0.1.0",
      encrypted: false,
      needsPassphrase: false,
    });
    const off = (id: string) => ({
      section: "macros",
      id,
      name: `Entry ${id}`,
      starts: ["Hotkey F8"],
      switches: ["triggersEnabled"],
      existsHere: false,
      sameHere: false,
      onHere: false,
    });
    vi.mocked(previewBackupRestore).mockResolvedValue({
      ...PREVIEW,
      switchedOff: [off("1"), { ...off("2"), existsHere: true, onHere: true, sameHere: true }],
    });
    await click("backup-restore-btn");
    await click("backup-restore-choose-file");
    await click("backup-restore-preview");
    const list = () => query("backup-restore-switched-off")?.textContent ?? "";
    expect(list()).toContain("1 entry starts by itself: restored switched off");
    expect(query("backup-restore-off-macros-1")?.textContent).toContain("Hotkey F8");
    // Replacing anything can change what an entry here uses.
    await click("backup-restore-include-settings");
    expect(list()).toContain("2 entries start by themselves");
    expect(query("backup-restore-off-macros-2")?.textContent).toContain("on here now");
    await click("backup-restore-include-settings");
    await click("backup-restore-include-macros");
    expect(query("backup-restore-switched-off")).toBeNull();
  });

  it("folds a long list of what arrives switched off", async () => {
    const entries = ["1", "2", "3", "4"].map((id) => ({
      section: "tunnels",
      id,
      name: id,
      starts: ["When termiHub starts"],
      switches: ["autoStart"],
      existsHere: false,
      sameHere: false,
      onHere: false,
    }));
    for (const [count, open] of [
      [3, true],
      [4, false],
    ] as const) {
      act(() => root.render(<BackupSwitchedOff entries={entries.slice(0, count)} />));
      const details = query("backup-restore-switched-off") as HTMLDetailsElement;
      expect(details.open).toBe(open);
      act(() => root.render(<></>));
    }
  });

  it("offers what is still off after a restore (#6056)", async () => {
    vi.mocked(listRestoredOff).mockResolvedValue([
      {
        section: "tunnels",
        id: "t",
        name: "DB",
        starts: ["When termiHub starts"],
        switches: ["autoStart"],
        existsHere: false,
        sameHere: false,
        onHere: false,
      },
    ]);
    render("master_password");
    await act(async () => {});
    expect(query("backup-restored-off")?.textContent).toContain(
      "1 restored entry that starts by itself is still off."
    );
    expect(restoredOffText(2)).toBe("2 restored entries that start by themselves are still off.");
    await click("backup-restored-off-review");
    expect(query("restored-off-row-tunnels-t")).not.toBeNull();
    await click("restored-off-keep");
    expect(query("restored-off-dialog")).toBeNull();
    expect(query("backup-restored-off")).toBeNull();
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
      switchedOff: [],
      restartRequired: true,
    });

    await click("backup-restore-btn");
    await click("backup-restore-choose-file");
    expect(query("backup-restore-file-name")?.textContent).toBe("backup.json");
    setInputValue("backup-restore-passphrase", PASSPHRASE);
    await click("backup-restore-preview");
    expect(previewBackupRestore).toHaveBeenCalledWith(BACKUP_JSON, PASSPHRASE);

    // The newer section cannot be chosen; settings is left out until ticked,
    // and replacing it is warned about once it is (#5824).
    expect((query("backup-restore-include-workflows") as HTMLButtonElement).disabled).toBe(true);
    expect(isChecked("backup-restore-include-settings")).toBe(false);
    expect(query("backup-restore-keep-settings")?.textContent).toMatch(/stay as they are/);
    expect(query("backup-restore-replace-warning")).toBeNull();
    await click("backup-restore-include-settings");
    expect(query("backup-restore-keep-settings")).toBeNull();
    expect(query("backup-restore-replace-warning")?.textContent).toMatch(/current settings:/);
    expect(isChecked("backup-restore-include-credentials")).toBe(true);
    // The user can confirm the file (#5824), and learns the restored passwords
    // land in a locked master-password vault.
    expect(query("backup-restore-preview-origin")?.textContent).toMatch(
      /^Created .+ · termiHub 0\.1\.0 · backup\.json$/
    );
    expect(query("backup-restore-credentials-locked")?.textContent).toMatch(/master password/);

    // Trust-store conflicts always keep the current keys: no strategy to pick,
    // and the kept hosts are listed.
    expect(query("backup-restore-conflicts-macros")).not.toBeNull();
    expect(query("backup-restore-conflicts-sshKnownHosts")).toBeNull();
    expect(query("backup-restore-note-sshKnownHosts")?.textContent).toMatch(/a:22/);

    // Leave macros and the host keys out.
    await click("backup-restore-include-macros");
    await click("backup-restore-include-sshKnownHosts");
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
