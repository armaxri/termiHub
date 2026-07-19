import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { JumpHostConfig, SshConfigImportHost } from "@/types/connection";
import { JumpHostSection } from "./JumpHostSection";
import { importSshConfigHosts } from "@/services/api";

// The section only pulls `importSshConfigHosts` from the api layer; a disabled
// section (no hops) renders no JumpHostEntry, so nothing else touches api here.
vi.mock("@/services/api", () => ({
  importSshConfigHosts: vi.fn(),
}));

const mockedImport = vi.mocked(importSshConfigHosts);

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const IMPORTABLE: SshConfigImportHost[] = [
  {
    name: "prod-target",
    proxyJump: [
      { host: "edge.example.com", port: 22, username: "e", authMethod: "agent" },
      { host: "bastion.example.com", port: 2222, username: "b", authMethod: "key" },
    ],
  },
];

describe("JumpHostSection — import from ~/.ssh/config", () => {
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

  it("exposes an import action even when jump hosts are disabled", () => {
    act(() => {
      root.render(<JumpHostSection value={undefined} targetHost="target" onChange={vi.fn()} />);
    });
    expect(query("jump-host-import-open")).toBeTruthy();
  });

  it("selecting an imported host calls onChange with the resolved hop chain", async () => {
    mockedImport.mockResolvedValue(IMPORTABLE);
    const onChange = vi.fn<(hops: JumpHostConfig[] | undefined) => void>();
    act(() => {
      root.render(<JumpHostSection value={undefined} targetHost="target" onChange={onChange} />);
    });

    act(() => {
      query("jump-host-import-open")!.click();
    });
    await flush();

    act(() => {
      (
        document.querySelector('[data-testid="ssh-config-import-host-prod-target"]') as HTMLElement
      ).click();
    });

    expect(onChange).toHaveBeenCalledWith(IMPORTABLE[0].proxyJump);
  });
});
