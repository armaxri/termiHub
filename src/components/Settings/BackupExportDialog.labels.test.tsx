import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { save } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "@/store/appStore";
import type { BackupSectionInfo } from "@/types/backup";
import { BackupExportDialog, backupSavedMessage } from "./BackupExportDialog";
import { OS_AUTH_UNAVAILABLE } from "@/test/osAuthFixtures";

vi.mock("@/services/api", async () => {
  const actual = await vi.importActual<typeof import("@/services/api")>("@/services/api");
  return {
    ...actual,
    listBackupSections: vi.fn(),
    exportBackup: vi.fn(),
    getOsAuthInfo: vi.fn(),
    localOpenFolder: vi.fn(),
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
import { exportBackup, getOsAuthInfo, listBackupSections, localOpenFolder } from "@/services/api";

const PASSPHRASE = "correct horse battery staple";

function section(overrides: Partial<BackupSectionInfo>): BackupSectionInfo {
  return {
    id: "connections",
    label: "Connections",
    description: "Saved connections",
    containsSecrets: false,
    requiresEncryption: false,
    present: true,
    itemCount: 1,
    ...overrides,
  };
}

/** The backend's order: Credentials is not among them and comes last today. */
const SECTIONS: BackupSectionInfo[] = [
  section({}),
  section({ id: "sharedCredentials", label: "Shared credentials", present: false }),
  section({ id: "settings", label: "Settings", description: "App settings" }),
  section({ id: "workspaces", label: "Workspaces", present: false }),
  section({ id: "macros", label: "Macros", present: false }),
  section({ id: "sshKnownHosts", label: "Trusted SSH host keys", requiresEncryption: true }),
];

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

function setInputValue(testId: string, value: string) {
  const input = query(testId) as HTMLInputElement;
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
      input,
      value
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function renderDialog(mode: "master_password" | "none") {
  useAppStore.setState({ credentialStoreStatus: { mode, status: "unlocked" } });
  await act(async () => {
    root.render(<BackupExportDialog open onOpenChange={() => {}} />);
  });
  await act(async () => {});
}

/** The visible `<label>` associated with the input carrying `testId`. */
function visibleLabelOf(testId: string): HTMLLabelElement | null {
  const input = query(testId) as HTMLInputElement | null;
  if (!input?.id) return null;
  return document.querySelector<HTMLLabelElement>(`label[for="${input.id}"]`);
}

describe("BackupExportDialog labels and layout (#5613)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
    vi.mocked(listBackupSections).mockResolvedValue(SECTIONS);
    vi.mocked(getOsAuthInfo).mockResolvedValue(OS_AUTH_UNAVAILABLE);
    vi.mocked(localOpenFolder).mockResolvedValue();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("gives every password field a visible label", async () => {
    await renderDialog("master_password");
    const expected: Record<string, string> = {
      "backup-export-master-password": "Current master password",
      "backup-export-passphrase": "Backup passphrase",
      "backup-export-confirm": "Repeat backup passphrase",
    };
    for (const [testId, text] of Object.entries(expected)) {
      const label = visibleLabelOf(testId);
      expect(label, `${testId} has no <label for>`).not.toBeNull();
      expect(label!.textContent).toBe(text);
      expect(query(`${testId}-label`)).toBe(label);
    }
  });

  it("groups the master password with the Credentials option", async () => {
    await renderDialog("master_password");
    const row = query("backup-export-credentials-row");
    expect(row).not.toBeNull();
    expect(row!.contains(query("backup-export-master-password"))).toBe(true);
  });

  it("shows the strength meter directly under the passphrase, before the repeat field", async () => {
    await renderDialog("none");
    setInputValue("backup-export-passphrase", PASSPHRASE);
    const field = query("backup-export-passphrase-field")!;
    const strength = query("backup-export-strength")!;
    expect(field.contains(strength)).toBe(true);
    expect(field.contains(query("backup-export-confirm"))).toBe(false);
  });

  it("lists Credentials right after Connections", async () => {
    await renderDialog("master_password");
    const rows = Array.from(query("backup-export-sections")!.children);
    expect(rows[0].contains(query("backup-export-section-connections"))).toBe(true);
    expect(rows[1].contains(query("backup-export-credentials"))).toBe(true);
  });

  it("collapses empty categories into one line", async () => {
    await renderDialog("master_password");
    expect(query("backup-export-section-workspaces")).toBeNull();
    expect(query("backup-export-section-macros")).toBeNull();
    expect(query("backup-export-empty-sections")?.textContent).toBe(
      "Nothing saved yet: shared credentials, workspaces, macros"
    );
    expect(query("backup-export-section-settings")).not.toBeNull();
  });

  it("names the file, uses the singular and offers to reveal it", async () => {
    await renderDialog("master_password");
    vi.mocked(exportBackup).mockResolvedValue({
      json: "{}",
      sections: ["connections", "settings"],
      credentialCount: 1,
      warnings: [],
    });
    vi.mocked(save).mockResolvedValue("/tmp/out/termihub-backup.json");
    setInputValue("backup-export-master-password", "master-pw");
    setInputValue("backup-export-passphrase", PASSPHRASE);
    setInputValue("backup-export-confirm", PASSPHRASE);
    await act(async () => {
      query("backup-export-submit")!.click();
    });
    expect(toast.success).toHaveBeenCalledWith(
      "Backup saved to termihub-backup.json — connections, settings and 1 credential.",
      expect.objectContaining({ action: expect.objectContaining({ label: expect.any(String) }) })
    );
    const opts = vi.mocked(toast.success).mock.calls[0][1]!;
    opts.action!.onClick();
    expect(localOpenFolder).toHaveBeenCalledWith("/tmp/out");
  });
});

describe("backupSavedMessage", () => {
  it("pluralises credentials and keeps acronyms", () => {
    expect(backupSavedMessage("b.json", ["Connections"], 2)).toBe(
      "Backup saved to b.json — connections and 2 credentials."
    );
    expect(backupSavedMessage("b.json", ["Trusted SSH host keys", "Settings"], null)).toBe(
      "Backup saved to b.json — trusted SSH host keys and settings."
    );
    expect(backupSavedMessage("b.json", [], 1)).toBe("Backup saved to b.json — 1 credential.");
  });
});
