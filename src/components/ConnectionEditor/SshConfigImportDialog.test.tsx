import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { SshConfigImportHost } from "@/types/connection";
import { SshConfigImportDialog } from "./SshConfigImportDialog";
import { importSshConfigHosts } from "@/services/api";

vi.mock("@/services/api", () => ({
  importSshConfigHosts: vi.fn(),
}));

const mockedImport = vi.mocked(importSshConfigHosts);

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

const HOSTS: SshConfigImportHost[] = [
  {
    name: "target",
    proxyJump: [{ host: "bastion.example.com", port: 2222, username: "bob", authMethod: "key" }],
  },
  {
    name: "deep",
    proxyJump: [
      { host: "edge.example.com", port: 22, username: "e", authMethod: "agent" },
      { host: "bastion.example.com", port: 22, username: "b", authMethod: "agent" },
    ],
  },
];

describe("SshConfigImportDialog", () => {
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
    render(
      <SshConfigImportDialog open={false} onOpenChange={() => {}} onImport={() => {}} />
    );
    expect(document.querySelector('[data-testid="ssh-config-import-dialog"]')).toBeNull();
    expect(mockedImport).not.toHaveBeenCalled();
  });

  it("lists hosts with a ProxyJump chain when opened", async () => {
    mockedImport.mockResolvedValue(HOSTS);
    render(<SshConfigImportDialog open onOpenChange={() => {}} onImport={() => {}} />);
    await flush();

    expect(document.querySelector('[data-testid="ssh-config-import-list"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="ssh-config-import-host-target"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="ssh-config-import-host-deep"]')).toBeTruthy();
  });

  it("selecting a host calls onImport with its hop chain and closes", async () => {
    mockedImport.mockResolvedValue(HOSTS);
    const onImport = vi.fn();
    const onOpenChange = vi.fn();
    render(<SshConfigImportDialog open onOpenChange={onOpenChange} onImport={onImport} />);
    await flush();

    act(() => {
      (
        document.querySelector('[data-testid="ssh-config-import-host-target"]') as HTMLElement
      ).click();
    });

    expect(onImport).toHaveBeenCalledWith(HOSTS[0].proxyJump);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows a friendly empty state when no ProxyJump hosts exist", async () => {
    mockedImport.mockResolvedValue([]);
    render(<SshConfigImportDialog open onOpenChange={() => {}} onImport={() => {}} />);
    await flush();

    expect(document.querySelector('[data-testid="ssh-config-import-empty"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="ssh-config-import-list"]')).toBeNull();
  });

  it("shows an error state (no crash) when the query rejects", async () => {
    mockedImport.mockRejectedValue(new Error("boom"));
    render(<SshConfigImportDialog open onOpenChange={() => {}} onImport={() => {}} />);
    await flush();

    expect(document.querySelector('[data-testid="ssh-config-import-error"]')).toBeTruthy();
  });
});
