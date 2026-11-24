/**
 * The restore preview's layout (#5935): the section list never scrolls inside
 * the dialog, kinds the backup holds nothing for fold into one line that names
 * them in its tooltip (and are left out of the restore), and the #5824 safe
 * defaults and origin line stay.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { useAppStore } from "@/store/appStore";
import type { BackupRestorePreview, BackupSectionPreview } from "@/types/backup";
import {
  BackupRestoreDialog,
  buildRestoreRequest,
  defaultChoices,
  emptyInBackupLine,
  emptyInBackupTooltip,
  isEmptyInBackup,
} from "./BackupRestoreDialog";

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
const backupCss = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "BackupRestore.css"),
  "utf8"
);

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

const EMPTY = { itemCount: 0, newCount: 0 };

const PREVIEW: BackupRestorePreview = {
  createdAt: "2026-11-13T00:00:00Z",
  appVersion: "0.1.0",
  encrypted: true,
  sections: [
    section({ id: "settings", label: "Settings", supportsMerge: false, ...EMPTY }),
    section({ id: "tunnels", label: "Tunnels", ...EMPTY }),
    section({}),
    section({ id: "macros", label: "Macros", ...EMPTY }),
    section({ id: "sshKnownHosts", label: "Trusted SSH host keys", ...EMPTY }),
    section({
      id: "workflows",
      label: "Workflows",
      status: "newer",
      message: "Workflows was backed up by a newer version of termiHub.",
      ...EMPTY,
    }),
    section({ id: "plugins", label: "Plugins", ...EMPTY, notes: ["Plugins come back off."] }),
  ],
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

function isChecked(testId: string): boolean {
  return query(testId)?.getAttribute("aria-checked") === "true";
}

async function click(testId: string) {
  await act(async () => {
    query(testId)!.click();
  });
}

async function openPreview() {
  useAppStore.setState({
    credentialStoreStatus: { mode: "master_password", status: "unlocked" },
  });
  act(() => root.render(<BackupRestoreDialog open onOpenChange={() => {}} />));
  await click("backup-restore-choose-file");
  const input = query("backup-restore-passphrase") as HTMLInputElement;
  act(() => {
    input.focus();
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
      input,
      PASSPHRASE
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("backup-restore-preview");
}

describe("restore preview empty kinds (#5935)", () => {
  it("folds only restorable, item-less sections with nothing to say", () => {
    const folded = PREVIEW.sections.filter(isEmptyInBackup).map((s) => s.id);
    // Settings has no items to count, a newer section says why it is skipped
    // and a section with notes has something to say: all three stay listed.
    expect(folded).toEqual(["tunnels", "macros", "sshKnownHosts"]);
  });

  it("words the line and names the kinds in the tooltip", () => {
    expect(emptyInBackupLine(1)).toBe("1 other kind is empty in this backup.");
    expect(emptyInBackupLine(3)).toBe("3 other kinds are empty in this backup.");
    const folded = PREVIEW.sections.filter(isEmptyInBackup);
    expect(emptyInBackupTooltip(folded)).toBe(
      "Empty in this backup: tunnels, macros, trusted SSH host keys"
    );
  });

  it("leaves folded sections out of the restore", () => {
    const choices = defaultChoices(PREVIEW);
    expect(choices.tunnels.include).toBe(false);
    choices.tunnels.include = true;
    const ids = buildRestoreRequest(PREVIEW, choices, null).sections.map((s) => s.id);
    expect(ids).toEqual(["connections", "plugins"]);
  });
});

describe("BackupRestoreDialog layout (#5935)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
    vi.mocked(openFileDialog).mockResolvedValue("/tmp/termihub-backup.json");
    vi.mocked(readTextFile).mockResolvedValue('{"format":"termihub-backup"}');
    vi.mocked(readBackupHeader).mockResolvedValue({
      createdAt: "2026-11-13T00:00:00Z",
      appVersion: "0.1.0",
      encrypted: true,
      needsPassphrase: true,
    });
    vi.mocked(previewBackupRestore).mockResolvedValue(PREVIEW);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("does not scroll the section list inside the dialog", async () => {
    await openPreview();
    expect(query("backup-restore-sections")!.classList).toContain("backup-restore__list");
    const rule = /\.backup-restore__list\s*\{([^}]*)\}/.exec(backupCss)?.[1] ?? "";
    expect(rule).not.toBe("");
    expect(rule).not.toMatch(/max-height/);
    expect(rule).not.toMatch(/overflow/);
  });

  it("folds the empty kinds into one line outside the list", async () => {
    await openPreview();
    for (const id of ["tunnels", "macros", "sshKnownHosts"]) {
      expect(query(`backup-restore-section-${id}`)).toBeNull();
    }
    const line = query("backup-restore-empty-sections")!;
    expect(line.textContent).toBe("3 other kinds are empty in this backup.");
    expect(line.getAttribute("title")).toBe(
      "Empty in this backup: tunnels, macros, trusted SSH host keys"
    );
    expect(query("backup-restore-sections")!.contains(line)).toBe(false);
    for (const id of ["settings", "connections", "workflows", "plugins"]) {
      expect(query(`backup-restore-section-${id}`)).not.toBeNull();
    }
  });

  it("lists Connections first, then Credentials, then the rest", async () => {
    await openPreview();
    const rows = Array.from(query("backup-restore-sections")!.children).map((li) =>
      li.getAttribute("data-testid")
    );
    expect(rows.slice(0, 2)).toEqual([
      "backup-restore-section-connections",
      "backup-restore-section-credentials",
    ]);
  });

  it("keeps the #5824 safe defaults and the origin line", async () => {
    await openPreview();
    expect(isChecked("backup-restore-include-connections")).toBe(true);
    expect(query("backup-restore-mode-connections")?.textContent).toMatch(/Merge/);
    expect(isChecked("backup-restore-include-settings")).toBe(false);
    expect(query("backup-restore-keep-settings")).not.toBeNull();
    expect(query("backup-restore-replace-warning")).toBeNull();
    expect(query("backup-restore-submit")!.className).toMatch(/ui-btn--primary/);
    expect(query("backup-restore-preview-origin")?.textContent).toMatch(
      /^Created .* · termiHub 0\.1\.0 · termihub-backup\.json$/
    );
  });
});
