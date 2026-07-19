/**
 * Tests for the guided Git-for-Windows setup affordance in the ConnectionEditor
 * local-shell picker (#1692), mirroring the Settings → Default Shell gate/dialog
 * tests from #1672.
 *
 * The gate reuses `shouldOfferGitBashSetup`: on Windows, when the local schema's
 * `shell` select lists no Unix shell (bash / Git Bash / WSL), a "Git Bash — set
 * up…" entry point appears beside the picker and opens the shared
 * `GitBashSetupDialog`. Closing the dialog re-fetches the connection-type
 * registry so a just-installed Git Bash becomes selectable without reopening the
 * editor. The affordance is hidden when a Unix shell is present and off Windows.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { resetRuntimeCache } from "@/hooks/useAvailableRuntimes";
import { isWindows } from "@/utils/platform";
import type { ConnectionTypeInfo, SavedConnection } from "@/types/connection";
import { ConnectionEditor } from "./ConnectionEditor";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/utils/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/platform")>()),
  isWindows: vi.fn(),
}));

// ResizeObserver is not available in jsdom
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const mockedInvoke = vi.mocked(invoke);
const mockedIsWindows = vi.mocked(isWindows);

/** Local schema whose `shell` select offers no Unix shell (Windows-only host). */
const LOCAL_NO_UNIX: ConnectionTypeInfo = {
  typeId: "local",
  displayName: "Local Shell",
  icon: "local",
  schema: {
    groups: [
      {
        key: "general",
        label: "General",
        fields: [
          {
            key: "shell",
            label: "Shell",
            fieldType: {
              type: "select",
              options: [
                { value: "powershell", label: "PowerShell" },
                { value: "cmd", label: "Command Prompt" },
                { value: "custom", label: "Custom" },
              ],
            },
            required: false,
            default: "powershell",
          },
        ],
      },
    ],
  },
  capabilities: { monitoring: false, fileBrowser: false, resize: true, persistent: false },
};

/** Same schema but with Git Bash detected — the offer must not appear. */
const LOCAL_WITH_GITBASH: ConnectionTypeInfo = {
  ...LOCAL_NO_UNIX,
  schema: {
    groups: [
      {
        key: "general",
        label: "General",
        fields: [
          {
            key: "shell",
            label: "Shell",
            fieldType: {
              type: "select",
              options: [
                { value: "powershell", label: "PowerShell" },
                { value: "cmd", label: "Command Prompt" },
                { value: "gitbash", label: "Git Bash" },
                { value: "custom", label: "Custom" },
              ],
            },
            required: false,
            default: "gitbash",
          },
        ],
      },
    ],
  },
};

const SSH_TYPE: ConnectionTypeInfo = {
  typeId: "ssh",
  displayName: "SSH",
  icon: "ssh",
  schema: {
    groups: [
      {
        key: "connection",
        label: "Connection",
        fields: [{ key: "host", label: "Host", fieldType: { type: "text" }, required: true }],
      },
    ],
  },
  capabilities: { monitoring: false, fileBrowser: false, resize: true, persistent: false },
};

let container: HTMLDivElement;
let root: Root;

function renderNewLocal(types: ConnectionTypeInfo[]) {
  useAppStore.setState({
    ...useAppStore.getInitialState(),
    connectionTypes: types,
  });
  act(() => {
    root.render(
      <ConnectionEditor tabId="tab-gitbash-1" meta={{ connectionId: "new" }} isVisible={true} />
    );
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function query(testId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

function click(testId: string) {
  const el = query(testId);
  if (!el) throw new Error(`missing element ${testId}`);
  act(() => (el as HTMLButtonElement).click());
}

describe("ConnectionEditor — guided Git Bash setup (#1692)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetRuntimeCache();
    mockedIsWindows.mockReturnValue(true);
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "check_docker_available") return Promise.resolve(false);
      if (cmd === "check_podman_available") return Promise.resolve(false);
      if (cmd === "get_connection_types") return Promise.resolve([LOCAL_WITH_GITBASH]);
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("offers the setup affordance on Windows when no Unix shell is detected", async () => {
    renderNewLocal([LOCAL_NO_UNIX]);
    await flush();

    expect(query("connection-editor-git-bash-setup")).not.toBeNull();
  });

  it("hides the affordance once a Unix shell (Git Bash) is present", async () => {
    renderNewLocal([LOCAL_WITH_GITBASH]);
    await flush();

    expect(query("connection-editor-git-bash-setup")).toBeNull();
  });

  it("hides the affordance off Windows", async () => {
    mockedIsWindows.mockReturnValue(false);
    renderNewLocal([LOCAL_NO_UNIX]);
    await flush();

    expect(query("connection-editor-git-bash-setup")).toBeNull();
  });

  it("does not offer the affordance for a non-local connection type", async () => {
    // An existing SSH connection edits as type "ssh": no local-shell picker, so
    // the Git Bash guidance never applies even on a Unix-shell-less Windows host.
    const sshConn: SavedConnection = {
      id: "conn-ssh-gitbash",
      name: "Box",
      config: { type: "ssh", config: { host: "10.0.0.1" } },
      folderId: null,
    };
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connections: [sshConn],
      connectionTypes: [SSH_TYPE, LOCAL_NO_UNIX],
    });
    act(() => {
      root.render(
        <ConnectionEditor
          tabId="tab-gitbash-2"
          meta={{ connectionId: sshConn.id, folderId: null }}
          isVisible={true}
        />
      );
    });
    await flush();

    expect(query("connection-editor-git-bash-setup")).toBeNull();
  });

  it("opens the shared setup dialog when the affordance is clicked", async () => {
    renderNewLocal([LOCAL_NO_UNIX]);
    await flush();

    click("connection-editor-git-bash-setup");
    await flush();

    expect(query("git-bash-setup")).not.toBeNull();
  });

  it("re-detects shells (re-fetches the type registry) when the dialog is dismissed", async () => {
    const fetchedRegistry = () =>
      mockedInvoke.mock.calls.some((c) => c[0] === "get_connection_types");

    renderNewLocal([LOCAL_NO_UNIX]);
    await flush();
    // The editor never fetches the registry itself, so it is untouched until the
    // dialog closes and the re-detect fires.
    expect(fetchedRegistry()).toBe(false);

    click("connection-editor-git-bash-setup");
    await flush();
    click("git-bash-setup-not-now");
    await flush();

    expect(fetchedRegistry()).toBe(true);
  });
});
