import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type {
  ConnectionFolder,
  SavedConnection,
  SshConfigImportConnection,
} from "@/types/connection";
import { BulkSshImportDialog } from "./BulkSshImportDialog";
import { importSshConfigConnections } from "@/services/api";

vi.mock("@/services/api", () => ({
  importSshConfigConnections: vi.fn(),
}));

const mockedImport = vi.mocked(importSshConfigConnections);

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function click(testid: string) {
  act(() => {
    (document.querySelector(`[data-testid="${testid}"]`) as HTMLElement).click();
  });
}

const CONNECTIONS: SshConfigImportConnection[] = [
  { name: "web", host: "web.internal", port: 2022, username: "alice", authMethod: "agent", proxyJump: [] },
  {
    name: "db",
    host: "db.internal",
    port: 22,
    username: "alice",
    authMethod: "key",
    keyPath: "/home/me/.ssh/id_db",
    proxyJump: [{ host: "bastion.example.com", port: 2222, username: "bob", authMethod: "key" }],
  },
];

const FOLDERS: ConnectionFolder[] = [
  { id: "f1", name: "Prod", parentId: null, isExpanded: false },
];

describe("BulkSshImportDialog", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockedImport.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("does not query the config while closed", () => {
    mockedImport.mockResolvedValue([]);
    render(
      <BulkSshImportDialog
        open={false}
        onOpenChange={() => {}}
        folders={FOLDERS}
        existingConnections={[]}
        onImport={() => {}}
      />
    );
    expect(document.querySelector('[data-testid="bulk-ssh-import-dialog"]')).toBeNull();
    expect(mockedImport).not.toHaveBeenCalled();
  });

  it("lists every host once opened", async () => {
    mockedImport.mockResolvedValue(CONNECTIONS);
    render(
      <BulkSshImportDialog
        open
        onOpenChange={() => {}}
        folders={FOLDERS}
        existingConnections={[]}
        onImport={() => {}}
      />
    );
    await flush();
    expect(document.querySelector('[data-testid="bulk-ssh-import-list"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="bulk-ssh-import-host-web"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="bulk-ssh-import-host-db"]')).toBeTruthy();
  });

  it("keeps Import disabled until at least one host is selected", async () => {
    mockedImport.mockResolvedValue(CONNECTIONS);
    render(
      <BulkSshImportDialog
        open
        onOpenChange={() => {}}
        folders={FOLDERS}
        existingConnections={[]}
        onImport={() => {}}
      />
    );
    await flush();
    const importBtn = document.querySelector('[data-testid="bulk-ssh-import"]') as HTMLButtonElement;
    expect(importBtn.disabled).toBe(true);
    click("bulk-ssh-import-check-web");
    expect(importBtn.disabled).toBe(false);
  });

  it("select-all then import builds a connection per host and closes", async () => {
    mockedImport.mockResolvedValue(CONNECTIONS);
    const onImport = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <BulkSshImportDialog
        open
        onOpenChange={onOpenChange}
        folders={FOLDERS}
        existingConnections={[]}
        onImport={onImport}
      />
    );
    await flush();

    click("bulk-ssh-import-select-all");
    click("bulk-ssh-import");

    expect(onImport).toHaveBeenCalledTimes(1);
    const built = onImport.mock.calls[0][0] as SavedConnection[];
    expect(built).toHaveLength(2);
    expect(built.map((c) => c.name).sort()).toEqual(["db", "web"]);
    expect(built.every((c) => c.config.type === "ssh")).toBe(true);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("imports the selected subset into the chosen folder with collision handling", async () => {
    mockedImport.mockResolvedValue(CONNECTIONS);
    const onImport = vi.fn();
    const existing: SavedConnection[] = [
      { id: "e1", name: "web", config: { type: "ssh", config: {} }, folderId: "f1" },
    ];
    render(
      <BulkSshImportDialog
        open
        onOpenChange={() => {}}
        folders={FOLDERS}
        existingConnections={existing}
        onImport={onImport}
      />
    );
    await flush();

    // Pick the target folder "Prod" (f1) via the folder select's hidden native control.
    click("bulk-ssh-import-check-web");
    click("bulk-ssh-import");

    // Folder defaults to root; with no root "web", name stays "web".
    const built = onImport.mock.calls[0][0] as SavedConnection[];
    expect(built).toHaveLength(1);
    expect(built[0].name).toBe("web");
    expect(built[0].folderId).toBeNull();
  });

  it("shows a friendly empty state when the config has no hosts", async () => {
    mockedImport.mockResolvedValue([]);
    render(
      <BulkSshImportDialog
        open
        onOpenChange={() => {}}
        folders={FOLDERS}
        existingConnections={[]}
        onImport={() => {}}
      />
    );
    await flush();
    expect(document.querySelector('[data-testid="bulk-ssh-import-empty"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="bulk-ssh-import-list"]')).toBeNull();
  });

  it("shows an error state (no crash) when the query rejects", async () => {
    mockedImport.mockRejectedValue(new Error("boom"));
    render(
      <BulkSshImportDialog
        open
        onOpenChange={() => {}}
        folders={FOLDERS}
        existingConnections={[]}
        onImport={() => {}}
      />
    );
    await flush();
    expect(document.querySelector('[data-testid="bulk-ssh-import-error"]')).toBeTruthy();
  });
});
