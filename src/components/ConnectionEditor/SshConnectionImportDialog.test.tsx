import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { SshConfigImportConnection } from "@/types/connection";
import { SshConnectionImportDialog } from "./SshConnectionImportDialog";
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

/** Let the mocked promise resolve and effects flush. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const CONNECTIONS: SshConfigImportConnection[] = [
  {
    name: "web",
    host: "web.internal",
    port: 2022,
    username: "alice",
    authMethod: "agent",
    proxyJump: [],
  },
  {
    name: "target",
    host: "target.internal",
    port: 22,
    username: "alice",
    authMethod: "key",
    keyPath: "/home/me/.ssh/id_target",
    proxyJump: [{ host: "bastion.example.com", port: 2222, username: "bob", authMethod: "key" }],
  },
];

describe("SshConnectionImportDialog", () => {
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

  it("renders nothing when closed and does not query the config", () => {
    mockedImport.mockResolvedValue([]);
    render(<SshConnectionImportDialog open={false} onOpenChange={() => {}} onImport={() => {}} />);
    expect(document.querySelector('[data-testid="ssh-connection-import-dialog"]')).toBeNull();
    expect(mockedImport).not.toHaveBeenCalled();
  });

  it("lists both direct and proxy-jump connections when opened", async () => {
    mockedImport.mockResolvedValue(CONNECTIONS);
    render(<SshConnectionImportDialog open onOpenChange={() => {}} onImport={() => {}} />);
    await flush();

    expect(document.querySelector('[data-testid="ssh-connection-import-list"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="ssh-connection-import-host-web"]')).toBeTruthy();
    expect(
      document.querySelector('[data-testid="ssh-connection-import-host-target"]')
    ).toBeTruthy();
  });

  it("selecting a connection calls onImport with the whole connection and closes", async () => {
    mockedImport.mockResolvedValue(CONNECTIONS);
    const onImport = vi.fn();
    const onOpenChange = vi.fn();
    render(<SshConnectionImportDialog open onOpenChange={onOpenChange} onImport={onImport} />);
    await flush();

    act(() => {
      (
        document.querySelector('[data-testid="ssh-connection-import-host-target"]') as HTMLElement
      ).click();
    });

    expect(onImport).toHaveBeenCalledWith(CONNECTIONS[1]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows a friendly empty state when the config has no hosts", async () => {
    mockedImport.mockResolvedValue([]);
    render(<SshConnectionImportDialog open onOpenChange={() => {}} onImport={() => {}} />);
    await flush();

    expect(document.querySelector('[data-testid="ssh-connection-import-empty"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="ssh-connection-import-list"]')).toBeNull();
  });

  it("shows an error state (no crash) when the query rejects", async () => {
    mockedImport.mockRejectedValue(new Error("boom"));
    render(<SshConnectionImportDialog open onOpenChange={() => {}} onImport={() => {}} />);
    await flush();

    expect(document.querySelector('[data-testid="ssh-connection-import-error"]')).toBeTruthy();
  });
});
