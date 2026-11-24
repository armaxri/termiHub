import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { save } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "@/store/appStore";
import type { BackupSectionInfo } from "@/types/backup";
import {
  BackupExportDialog,
  backupExportSteps,
  backupSavedMessage,
  emptySectionsLine,
  plainBackupBlockedReason,
} from "./BackupExportDialog";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
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
const backupCss = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "BackupRestore.css"),
  "utf8"
);

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

async function click(testId: string) {
  await act(async () => {
    query(testId)!.click();
  });
}

function isChecked(testId: string): boolean {
  return query(testId)?.getAttribute("aria-checked") === "true";
}

/** Every password input currently in the dialog. */
function passwordFields(): string[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>("input[data-testid]"))
    .filter((input) => input.type === "password")
    .map((input) => input.dataset.testid!);
}

describe("BackupExportDialog labels and layout (#5613, #5847)", () => {
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
    const expectLabel = (testId: string, text: string) => {
      const label = visibleLabelOf(testId);
      expect(label, `${testId} has no <label for>`).not.toBeNull();
      expect(label!.textContent).toBe(text);
      expect(query(`${testId}-label`)).toBe(label);
    };
    await click("backup-export-next");
    expectLabel("backup-export-passphrase", "Backup passphrase");
    expectLabel("backup-export-confirm", "Repeat backup passphrase");
    setInputValue("backup-export-passphrase", PASSPHRASE);
    setInputValue("backup-export-confirm", PASSPHRASE);
    await click("backup-export-next");
    expectLabel("backup-export-master-password", "Master password");
  });

  it("asks for one secret per step, the master password last (#5847)", async () => {
    await renderDialog("master_password");
    expect(query("backup-export-step")?.textContent).toBe("Step 1 of 3 · What to back up");
    expect(passwordFields()).toEqual([]);
    expect(query("backup-export-credentials-detail")?.textContent).toMatch(
      /enter your master password in the last step/
    );

    await click("backup-export-next");
    expect(query("backup-export-step")?.textContent).toBe("Step 2 of 3 · Backup passphrase");
    expect(passwordFields()).toEqual(["backup-export-passphrase", "backup-export-confirm"]);
    expect(query("backup-export-rule")?.textContent).toMatch(
      /^Everything in this file is locked with the backup passphrase\./
    );

    setInputValue("backup-export-passphrase", PASSPHRASE);
    setInputValue("backup-export-confirm", PASSPHRASE);
    await click("backup-export-next");
    expect(query("backup-export-step")?.textContent).toBe("Step 3 of 3 · Master password");
    expect(passwordFields()).toEqual(["backup-export-master-password"]);
    expect(query("backup-export-master-purpose")?.textContent).toMatch(/master password/);
    expect(query("backup-export-submit")).not.toBeNull();
    expect(query("backup-export-next")).toBeNull();
  });

  it("skips the master password step when credentials are not included", async () => {
    await renderDialog("master_password");
    await click("backup-export-credentials");
    await click("backup-export-next");
    expect(query("backup-export-step")?.textContent).toBe("Step 2 of 2 · Backup passphrase");
    expect(query("backup-export-submit")).not.toBeNull();
  });

  it("does not move on until the step is valid, and Back keeps what was typed", async () => {
    await renderDialog("none");
    await click("backup-export-next");
    setInputValue("backup-export-passphrase", PASSPHRASE);
    setInputValue("backup-export-confirm", "something else entirely");
    await click("backup-export-submit");
    expect(query("backup-export-error")?.textContent).toMatch(/do not match/);
    expect(exportBackup).not.toHaveBeenCalled();

    await click("backup-export-back");
    expect(query("backup-export-error")).toBeNull();
    expect(query("backup-export-sections")).not.toBeNull();
    await click("backup-export-next");
    expect((query("backup-export-passphrase") as HTMLInputElement).value).toBe(PASSPHRASE);
  });

  it("shows the strength meter directly under the passphrase, before the repeat field", async () => {
    await renderDialog("none");
    await click("backup-export-next");
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

  it("collapses empty categories into one short line outside the list (#5847)", async () => {
    await renderDialog("master_password");
    expect(query("backup-export-section-workspaces")).toBeNull();
    expect(query("backup-export-section-macros")).toBeNull();
    const line = query("backup-export-empty-sections")!;
    expect(line.textContent).toBe("3 other kinds have nothing saved yet.");
    expect(line.getAttribute("title")).toBe(
      "Nothing saved yet: shared credentials, workspaces, macros"
    );
    expect(query("backup-export-sections")!.contains(line)).toBe(false);
    expect(query("backup-export-section-settings")).not.toBeNull();
  });

  it("does not scroll the list inside the dialog (#5847)", async () => {
    await renderDialog("master_password");
    expect(query("backup-export-sections")!.classList).toContain("backup-export__list");
    const rule = /\.backup-export__list\s*\{([^}]*)\}/.exec(backupCss)?.[1] ?? "";
    expect(rule).toMatch(/max-height:\s*none/);
    expect(rule).toMatch(/overflow:\s*visible/);
  });

  it("saves without a passphrase only when nothing locked-only is included", async () => {
    await renderDialog("master_password");
    await click("backup-export-next");
    expect((query("backup-export-plain") as HTMLButtonElement).disabled).toBe(true);
    expect(query("backup-export-plain-detail")?.textContent).toBe(
      "Not possible while the backup includes credentials and trusted SSH host keys."
    );

    await click("backup-export-back");
    await click("backup-export-credentials");
    await click("backup-export-section-sshKnownHosts");
    await click("backup-export-next");
    expect((query("backup-export-plain") as HTMLButtonElement).disabled).toBe(false);
    await click("backup-export-plain");
    expect(isChecked("backup-export-plain")).toBe(true);
    expect(query("backup-export-plain-warning")).not.toBeNull();
    expect(query("backup-export-rule")).toBeNull();
    expect(query("backup-export-passphrase")).toBeNull();

    vi.mocked(exportBackup).mockResolvedValue({
      json: "{}",
      sections: ["connections", "settings"],
      credentialCount: null,
      warnings: [],
    });
    vi.mocked(save).mockResolvedValue("/tmp/out/termihub-backup.json");
    await click("backup-export-submit");
    expect(exportBackup).toHaveBeenCalledWith(
      { sections: ["connections", "settings"], includeCredentials: false, encrypt: false },
      null,
      null
    );
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
    await click("backup-export-next");
    setInputValue("backup-export-passphrase", PASSPHRASE);
    setInputValue("backup-export-confirm", PASSPHRASE);
    await click("backup-export-next");
    setInputValue("backup-export-master-password", "master-pw");
    await click("backup-export-submit");
    expect(exportBackup).toHaveBeenCalledWith(
      expect.objectContaining({ includeCredentials: true, encrypt: true }),
      PASSPHRASE,
      "master-pw"
    );
    expect(toast.success).toHaveBeenCalledWith(
      "Backup saved to termihub-backup.json — connections, settings and 1 credential.",
      expect.objectContaining({ action: expect.objectContaining({ label: expect.any(String) }) })
    );
    const opts = vi.mocked(toast.success).mock.calls[0][1]!;
    opts.action!.onClick();
    expect(localOpenFolder).toHaveBeenCalledWith("/tmp/out");
  });
});

describe("backup export step helpers (#5847)", () => {
  it("adds the master password step only when it is needed", () => {
    expect(backupExportSteps(false)).toEqual(["choose", "passphrase"]);
    expect(backupExportSteps(true)).toEqual(["choose", "passphrase", "masterPassword"]);
  });

  it("words the empty-categories line", () => {
    expect(emptySectionsLine(1)).toBe("1 other kind has nothing saved yet.");
    expect(emptySectionsLine(8)).toBe("8 other kinds have nothing saved yet.");
  });

  it("explains why a plain backup is not possible", () => {
    expect(plainBackupBlockedReason([])).toBeNull();
    expect(plainBackupBlockedReason(["Credentials"])).toBe(
      "Not possible while the backup includes credentials."
    );
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
