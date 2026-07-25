import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { TooltipProvider } from "@/components/ui";
import { SshTrustSettings } from "./SshTrustSettings";

vi.mock("@/utils/frontendLog", () => ({
  frontendLog: vi.fn(),
}));

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return {
    ...actual,
    toast: { success: vi.fn(), error: vi.fn() },
  };
});

const mockedInvoke = vi.mocked(invoke);

type TrustList = { host: string; fingerprints: string[] }[];

/** Route the two SSH trust commands; default to an empty list. */
function setup(list: TrustList = []) {
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === "ssh_trust_list") return list;
    if (cmd === "ssh_trust_forget") return true;
    return undefined;
  });
}

let container: HTMLDivElement;
let root: Root;

/** Render and flush the mount-time load effect. */
async function render(props: { visibleFields?: Set<string> } = {}) {
  await act(async () => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <SshTrustSettings {...props} />
      </TooltipProvider>
    );
  });
}

function query(testId: string): Element | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function buttonByLabel(label: string): HTMLButtonElement | null {
  return container.querySelector(`button[aria-label="${label}"]`);
}

async function click(el: Element | null) {
  await act(async () => {
    el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("SshTrustSettings", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it("shows the empty state when nothing is remembered", async () => {
    setup([]);
    await render();
    expect(query("ssh-trust-empty")).not.toBeNull();
    expect(mockedInvoke).toHaveBeenCalledWith("ssh_trust_list");
  });

  it("lists remembered hosts and their fingerprints", async () => {
    setup([
      { host: "server.example:22", fingerprints: ["SHA256:AA/BB", "SHA256:CC/DD"] },
      { host: "other:2222", fingerprints: ["SHA256:11/22"] },
    ]);
    await render();
    const hosts = container.querySelectorAll('[data-testid="ssh-trust-host"]');
    expect(hosts).toHaveLength(2);
    expect(container.textContent).toContain("server.example:22");
    expect(container.textContent).toContain("SHA256:AA/BB");
    expect(container.textContent).toContain("SHA256:CC/DD");
    expect(container.textContent).toContain("other:2222");
  });

  it("revokes a single fingerprint and removes it from the list", async () => {
    setup([{ host: "server.example:22", fingerprints: ["SHA256:AA/BB", "SHA256:CC/DD"] }]);
    await render();

    await click(buttonByLabel("Revoke host key SHA256:AA/BB for server.example:22"));

    expect(mockedInvoke).toHaveBeenCalledWith("ssh_trust_forget", {
      host: "server.example:22",
      fingerprint: "SHA256:AA/BB",
    });
    expect(container.textContent).not.toContain("SHA256:AA/BB");
    expect(container.textContent).toContain("SHA256:CC/DD");
  });

  it("dropping a host's last fingerprint removes the host", async () => {
    setup([{ host: "server.example:22", fingerprints: ["SHA256:AA/BB"] }]);
    await render();

    await click(buttonByLabel("Revoke host key SHA256:AA/BB for server.example:22"));

    expect(container.querySelectorAll('[data-testid="ssh-trust-host"]')).toHaveLength(0);
    expect(query("ssh-trust-empty")).not.toBeNull();
  });

  it("forgets a whole host without a fingerprint argument", async () => {
    setup([{ host: "server.example:22", fingerprints: ["SHA256:AA/BB", "SHA256:CC/DD"] }]);
    await render();

    await click(buttonByLabel("Forget all remembered host keys for server.example:22"));

    expect(mockedInvoke).toHaveBeenCalledWith("ssh_trust_forget", {
      host: "server.example:22",
      fingerprint: null,
    });
    expect(container.querySelectorAll('[data-testid="ssh-trust-host"]')).toHaveLength(0);
  });

  it("hides itself when visibleFields excludes the SSH trust field", async () => {
    setup([{ host: "server.example:22", fingerprints: ["SHA256:AA/BB"] }]);
    await render({ visibleFields: new Set(["somethingElse"]) });
    expect(query("settings-ssh-trust")).toBeNull();
  });
});
