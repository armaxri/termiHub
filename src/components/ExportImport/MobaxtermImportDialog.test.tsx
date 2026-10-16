import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type {
  ConnectionFolder,
  MobaxtermHostKey,
  MobaxtermImportPreview,
  MobaxtermSession,
  SavedConnection,
} from "@/types/connection";
import { MobaxtermImportDialog } from "./MobaxtermImportDialog";
import {
  discoverMobaxtermConfigs,
  importMobaxtermHostKeys,
  previewMobaxtermImport,
} from "@/services/api";
import { open as openFileDialog } from "@/services/nativeDialog";

vi.mock("@/services/api", () => ({
  discoverMobaxtermConfigs: vi.fn(),
  previewMobaxtermImport: vi.fn(),
  importMobaxtermHostKeys: vi.fn(),
}));

vi.mock("@/services/nativeDialog", () => ({
  open: vi.fn(),
}));

const mockedDiscover = vi.mocked(discoverMobaxtermConfigs);
const mockedPreview = vi.mocked(previewMobaxtermImport);
const mockedPick = vi.mocked(openFileDialog);
const mockedImportKeys = vi.mocked(importMobaxtermHostKeys);

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function q(testid: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testid}"]`);
}

async function click(testid: string) {
  await act(async () => {
    (q(testid) as HTMLElement).click();
  });
  await flush();
}

const SSH: MobaxtermSession = {
  key: "moba-0",
  name: "Lab router",
  folderPath: ["Lab"],
  sessionType: "SSH",
  target: "netops@10.0.0.1",
  connectionType: "ssh",
  settings: { host: "10.0.0.1", port: 22, username: "netops", authMethod: "password" },
  notes: [],
};

const SERIAL: MobaxtermSession = {
  key: "moba-1",
  name: "Console",
  folderPath: [],
  sessionType: "Serial",
  target: "COM3 @ 115200",
  connectionType: "serial",
  settings: { port: "COM3", baudRate: "115200" },
  notes: ["Mark/space parity is not supported; using none."],
};

const BROWSER: MobaxtermSession = {
  key: "moba-2",
  name: "Docs",
  folderPath: [],
  sessionType: "Browser",
  target: "",
  skipReason: "termiHub has no Browser connection type.",
  notes: [],
};

const NEW_KEY: MobaxtermHostKey = {
  id: "ssh-ed25519@22:203.0.113.5",
  host: "203.0.113.5",
  port: 22,
  keyType: "ssh-ed25519",
  fingerprint: "SHA256:D0k/zRUCvz3ysFQzAG0q7hQl2n/TE2fiVuLyLO5vJFw",
  knownHostsLine: "203.0.113.5 ssh-ed25519 AAAA",
  status: "new",
};

const CONFLICT_KEY: MobaxtermHostKey = {
  ...NEW_KEY,
  id: "ssh-ed25519@22:192.0.2.7",
  host: "192.0.2.7",
  status: "conflict",
  reason: "termiHub already trusts a different key for this host; it is not replaced.",
};

const INVALID_KEY: MobaxtermHostKey = {
  id: "dss@22:192.0.2.8",
  host: "192.0.2.8",
  port: 22,
  status: "invalid",
  reason: "DSA host keys are obsolete and not supported.",
};

function preview(
  sessions: MobaxtermSession[],
  path = "C:\\Users\\a\\MobaXterm.ini",
  hostKeys: MobaxtermHostKey[] = [],
  notes: string[] = []
) {
  const p: MobaxtermImportPreview = {
    sourcePath: path,
    encoding: "utf-8",
    sessions,
    hostKeys,
    notes,
  };
  return p;
}

const FOLDERS: ConnectionFolder[] = [];
const EXISTING: SavedConnection[] = [];

function renderDialog(onImport = vi.fn().mockResolvedValue(undefined), onOpenChange = vi.fn()) {
  render(
    <MobaxtermImportDialog
      open
      onOpenChange={onOpenChange}
      folders={FOLDERS}
      existingConnections={EXISTING}
      onImport={onImport}
    />
  );
  return { onImport, onOpenChange };
}

describe("MobaxtermImportDialog", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("does nothing while closed", () => {
    render(
      <MobaxtermImportDialog
        open={false}
        onOpenChange={vi.fn()}
        folders={FOLDERS}
        existingConnections={EXISTING}
        onImport={vi.fn()}
      />
    );
    expect(mockedDiscover).not.toHaveBeenCalled();
  });

  it("previews the discovered configuration with importable and skipped sessions", async () => {
    mockedDiscover.mockResolvedValue([
      { path: "C:\\Users\\a\\MobaXterm.ini", source: "installed" },
    ]);
    mockedPreview.mockResolvedValue(preview([SSH, SERIAL, BROWSER]));
    renderDialog();
    await flush();

    expect(mockedPreview).toHaveBeenCalledWith("C:\\Users\\a\\MobaXterm.ini");
    expect(q("mobaxterm-import-source")?.textContent).toContain("MobaXterm.ini");
    expect(q("mobaxterm-import-row-moba-0")?.textContent).toContain("SSH · netops@10.0.0.1 · Lab");
    expect(q("mobaxterm-import-row-moba-1")?.textContent).toContain("Mark/space parity");
    expect(q("mobaxterm-import-skip-moba-2")?.textContent).toContain("no Browser connection type");
    expect(q("mobaxterm-import-check-moba-2")).toBeNull();
    // Every importable session starts selected.
    expect(q("mobaxterm-import-submit")?.textContent).toBe("Import 2");
  });

  it("shows file-level notes such as unimported global appearance settings", async () => {
    mockedDiscover.mockResolvedValue([
      { path: "C:\\Users\\a\\MobaXterm.ini", source: "installed" },
    ]);
    const note = "MobaXterm's global appearance settings ([Font]) were not imported.";
    mockedPreview.mockResolvedValue(preview([SSH], undefined, [], [note]));
    renderDialog();
    await flush();
    expect(q("mobaxterm-import-file-notes")?.textContent).toContain("[Font]");
  });

  it("shows no file-level notes when there are none", async () => {
    mockedDiscover.mockResolvedValue([
      { path: "C:\\Users\\a\\MobaXterm.ini", source: "installed" },
    ]);
    mockedPreview.mockResolvedValue(preview([SSH]));
    renderDialog();
    await flush();
    expect(q("mobaxterm-import-file-notes")).toBeNull();
  });

  it("offers a manual file pick when nothing is discovered", async () => {
    mockedDiscover.mockResolvedValue([]);
    mockedPick.mockResolvedValue("/home/a/export.mxtsessions");
    mockedPreview.mockResolvedValue(preview([SSH], "/home/a/export.mxtsessions"));
    renderDialog();
    await flush();

    expect(q("mobaxterm-import-source")?.textContent).toContain("No MobaXterm configuration");
    expect((q("mobaxterm-import-submit") as HTMLButtonElement).disabled).toBe(true);

    await click("mobaxterm-import-choose-file");
    expect(mockedPick).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [expect.objectContaining({ extensions: ["ini", "mxtsessions"] })],
      })
    );
    expect(mockedPreview).toHaveBeenCalledWith("/home/a/export.mxtsessions");
    expect(q("mobaxterm-import-row-moba-0")).not.toBeNull();
  });

  it("treats a discovery failure like nothing found", async () => {
    mockedDiscover.mockRejectedValue("boom");
    renderDialog();
    await flush();
    expect(q("mobaxterm-import-source")?.textContent).toContain("No MobaXterm configuration");
    expect(mockedPreview).not.toHaveBeenCalled();
  });

  it("shows a read error with the backend message", async () => {
    mockedDiscover.mockResolvedValue([{ path: "C:\\x.ini", source: "installed" }]);
    mockedPreview.mockRejectedValue("read C:\\x.ini: access denied");
    renderDialog();
    await flush();
    expect(q("mobaxterm-import-error")?.textContent).toContain("access denied");
  });

  it("shows an empty state for a file without sessions", async () => {
    mockedDiscover.mockResolvedValue([{ path: "C:\\x.ini", source: "installed" }]);
    mockedPreview.mockResolvedValue(preview([]));
    renderDialog();
    await flush();
    expect(q("mobaxterm-import-empty")).not.toBeNull();
  });

  it("imports only the selected sessions with their folder tree, then closes", async () => {
    mockedDiscover.mockResolvedValue([{ path: "C:\\x.ini", source: "installed" }]);
    mockedPreview.mockResolvedValue(preview([SSH, SERIAL, BROWSER]));
    const { onImport, onOpenChange } = renderDialog();
    await flush();

    await click("mobaxterm-import-check-moba-1");
    expect(q("mobaxterm-import-submit")?.textContent).toBe("Import 1");
    await click("mobaxterm-import-submit");

    expect(onImport).toHaveBeenCalledTimes(1);
    const [folders, connections] = onImport.mock.calls[0] as [
      ConnectionFolder[],
      SavedConnection[],
    ];
    expect(folders.map((f) => f.id)).toEqual(["Lab"]);
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({
      name: "Lab router",
      folderId: "Lab",
      config: { type: "ssh", config: { host: "10.0.0.1" } },
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("select-all toggles every importable session", async () => {
    mockedDiscover.mockResolvedValue([{ path: "C:\\x.ini", source: "installed" }]);
    mockedPreview.mockResolvedValue(preview([SSH, SERIAL]));
    renderDialog();
    await flush();

    await click("mobaxterm-import-select-all");
    expect(q("mobaxterm-import-submit")?.textContent).toBe("Import");
    expect((q("mobaxterm-import-submit") as HTMLButtonElement).disabled).toBe(true);
    await click("mobaxterm-import-select-all");
    expect(q("mobaxterm-import-submit")?.textContent).toBe("Import 2");
  });

  describe("host keys (#4852)", () => {
    const KEYS = [NEW_KEY, CONFLICT_KEY, INVALID_KEY];

    it("lists host keys with their status and leaves the opt-in off", async () => {
      mockedDiscover.mockResolvedValue([{ path: "C:\\x.ini", source: "installed" }]);
      mockedPreview.mockResolvedValue(preview([SSH], "C:\\x.ini", KEYS));
      renderDialog();
      await flush();

      expect(q("mobaxterm-import-hostkeys")?.textContent).toContain(
        "Also import 1 trusted host key"
      );
      expect(q(`mobaxterm-import-hostkey-${NEW_KEY.id}`)?.textContent).toContain("SHA256:D0k");
      expect(q(`mobaxterm-import-hostkey-${CONFLICT_KEY.id}`)?.textContent).toContain(
        "different key"
      );
      expect(q(`mobaxterm-import-hostkey-${INVALID_KEY.id}`)?.textContent).toContain("DSA");
      const optin = q("mobaxterm-import-hostkeys-optin");
      expect(optin?.getAttribute("aria-checked")).toBe("false");
    });

    it("does not trust any host key without the opt-in", async () => {
      mockedDiscover.mockResolvedValue([{ path: "C:\\x.ini", source: "installed" }]);
      mockedPreview.mockResolvedValue(preview([SSH], "C:\\x.ini", KEYS));
      const { onImport } = renderDialog();
      await flush();

      await click("mobaxterm-import-submit");
      expect(onImport).toHaveBeenCalledTimes(1);
      expect(mockedImportKeys).not.toHaveBeenCalled();
    });

    it("imports only the new keys after opting in, even with no sessions selected", async () => {
      mockedDiscover.mockResolvedValue([{ path: "C:\\x.ini", source: "installed" }]);
      mockedPreview.mockResolvedValue(preview([SSH], "C:\\x.ini", KEYS));
      mockedImportKeys.mockResolvedValue({ imported: 1, alreadyTrusted: 0, skipped: [] });
      const { onImport, onOpenChange } = renderDialog();
      await flush();

      await click("mobaxterm-import-select-all");
      expect((q("mobaxterm-import-submit") as HTMLButtonElement).disabled).toBe(true);
      await click("mobaxterm-import-hostkeys-optin");
      expect(q("mobaxterm-import-submit")?.textContent).toBe("Import host keys");
      await click("mobaxterm-import-submit");

      expect(onImport).not.toHaveBeenCalled();
      expect(mockedImportKeys).toHaveBeenCalledWith("C:\\x.ini", [
        { id: NEW_KEY.id, fingerprint: NEW_KEY.fingerprint },
      ]);
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it("shows a file with only host keys instead of the empty state", async () => {
      mockedDiscover.mockResolvedValue([{ path: "C:\\x.ini", source: "installed" }]);
      mockedPreview.mockResolvedValue(preview([], "C:\\x.ini", [NEW_KEY]));
      renderDialog();
      await flush();
      expect(q("mobaxterm-import-empty")).toBeNull();
      expect(q("mobaxterm-import-hostkeys")).not.toBeNull();
    });
  });
});
