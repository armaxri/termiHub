import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { ExportDialog } from "./ExportDialog";

vi.mock("@/services/api", () => ({
  exportConnectionsEncrypted: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  writeTextFile: vi.fn(),
}));

import { exportConnectionsEncrypted } from "@/services/api";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";

const mockedExport = vi.mocked(exportConnectionsEncrypted);
const mockedSave = vi.mocked(save);
const mockedWrite = vi.mocked(writeTextFile);

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

describe("ExportDialog", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    useAppStore.setState(useAppStore.getInitialState());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("does not render when closed", () => {
    act(() => root.render(<ExportDialog />));
    expect(document.querySelector(".ui-modal")).toBeNull();
  });

  it("renders through the Modal primitive when open", () => {
    useAppStore.setState({ exportDialogOpen: true });
    act(() => root.render(<ExportDialog />));

    expect(document.querySelector(".ui-modal")).not.toBeNull();
    expect(query("export-dialog-title")).not.toBeNull();
    expect(query("export-submit")).not.toBeNull();
  });

  it("fires the export action (plain mode) on submit", async () => {
    mockedExport.mockResolvedValueOnce("{}");
    mockedSave.mockResolvedValueOnce("/tmp/out.json");
    mockedWrite.mockResolvedValueOnce(undefined);
    useAppStore.setState({ exportDialogOpen: true });

    act(() => root.render(<ExportDialog />));

    const submit = query("export-submit") as HTMLButtonElement;
    await act(async () => {
      submit.click();
    });

    expect(mockedExport).toHaveBeenCalledWith(null, null, null);
  });

  it("explains that plain mode exports shared credentials by name only", () => {
    useAppStore.setState({ exportDialogOpen: true });
    act(() => root.render(<ExportDialog />));

    expect(query("export-plain-hint")?.textContent).toContain("Shared credentials");
  });

  describe("master-password re-authentication (#3598)", () => {
    function setInput(testId: string, value: string) {
      const input = query(testId) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      act(() => {
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }

    function chooseEncrypted() {
      const radio = query("export-mode-encrypted") as HTMLElement;
      act(() => radio.click());
    }

    function openWith(mode: "master_password" | "os_keychain" | "none") {
      useAppStore.setState({
        exportDialogOpen: true,
        credentialStoreStatus: { mode, status: "unlocked" },
      });
      act(() => root.render(<ExportDialog />));
    }

    it("shows the master-password field only with credentials in master-password mode", () => {
      openWith("master_password");
      expect(query("export-master-password")).toBeNull();
      chooseEncrypted();
      expect(query("export-master-password")).not.toBeNull();
    });

    it("does not show the master-password field in OS-keychain mode", () => {
      openWith("os_keychain");
      chooseEncrypted();
      expect(query("export-password")).not.toBeNull();
      expect(query("export-master-password")).toBeNull();
    });

    it("does not show the master-password field when credential storage is off", () => {
      openWith("none");
      chooseEncrypted();
      expect(query("export-master-password")).toBeNull();
    });

    it("requires the master password before exporting", () => {
      openWith("master_password");
      chooseEncrypted();
      setInput("export-password", "export-pass");
      setInput("export-confirm-password", "export-pass");
      expect((query("export-submit") as HTMLButtonElement).disabled).toBe(true);
      setInput("export-master-password", "master-pw");
      expect((query("export-submit") as HTMLButtonElement).disabled).toBe(false);
    });

    it("passes the master password to the export and clears it afterwards", async () => {
      mockedExport.mockResolvedValueOnce("{}");
      mockedSave.mockResolvedValueOnce("/tmp/out.json");
      mockedWrite.mockResolvedValueOnce(undefined);
      openWith("master_password");
      chooseEncrypted();
      setInput("export-master-password", "master-pw");
      setInput("export-password", "export-pass");
      setInput("export-confirm-password", "export-pass");

      await act(async () => {
        (query("export-submit") as HTMLButtonElement).click();
      });

      expect(mockedExport).toHaveBeenCalledWith("export-pass", null, "master-pw");
      expect(mockedWrite).toHaveBeenCalledWith("/tmp/out.json", "{}");
    });

    it("shows the backend error, writes nothing, and clears the master password", async () => {
      mockedExport.mockRejectedValueOnce(new Error("The master password is incorrect."));
      openWith("master_password");
      chooseEncrypted();
      setInput("export-master-password", "wrong");
      setInput("export-password", "export-pass");
      setInput("export-confirm-password", "export-pass");

      await act(async () => {
        (query("export-submit") as HTMLButtonElement).click();
      });

      expect(mockedSave).not.toHaveBeenCalled();
      expect(mockedWrite).not.toHaveBeenCalled();
      expect(query("export-error")?.textContent).toContain("master password is incorrect");
      expect((query("export-master-password") as HTMLInputElement).value).toBe("");
    });

    it("sends no master password in OS-keychain mode", async () => {
      mockedExport.mockResolvedValueOnce("{}");
      mockedSave.mockResolvedValueOnce("/tmp/out.json");
      mockedWrite.mockResolvedValueOnce(undefined);
      openWith("os_keychain");
      chooseEncrypted();
      setInput("export-password", "export-pass");
      setInput("export-confirm-password", "export-pass");

      await act(async () => {
        (query("export-submit") as HTMLButtonElement).click();
      });

      expect(mockedExport).toHaveBeenCalledWith("export-pass", null, null);
    });
  });
});
