import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { resetRuntimeCache } from "@/hooks/useAvailableRuntimes";
import { ConnectionEditor } from "./ConnectionEditor";
import type { ConnectionTypeInfo } from "@/types/connection";
import type { SavedConnection } from "@/types/connection";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

// ResizeObserver is not available in jsdom
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const mockedInvoke = vi.mocked(invoke);

/** Minimal SSH connection type schema with password and savePassword fields. */
const SSH_TYPE: ConnectionTypeInfo = {
  typeId: "ssh",
  displayName: "SSH",
  icon: "ssh",
  schema: {
    groups: [
      {
        key: "auth",
        label: "Authentication",
        fields: [
          {
            key: "password",
            label: "Password",
            fieldType: { type: "password" },
            required: false,
          },
          {
            key: "savePassword",
            label: "Save Password",
            fieldType: { type: "boolean" },
            required: false,
          },
        ],
      },
    ],
  },
  capabilities: {
    monitoring: false,
    fileBrowser: false,
    resize: true,
    persistent: false,
  },
};

const CONN_ID = "conn-test-123";

/** Existing SSH connection with savePassword=true but password stripped (as stored). */
const EXISTING_CONN: SavedConnection = {
  id: CONN_ID,
  name: "My SSH Server",
  config: {
    type: "ssh",
    config: {
      host: "192.168.1.1",
      username: "user",
      savePassword: true,
      // password is absent — stripped when saved to disk
    },
  },
  folderId: null,
};

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => {
    root.render(
      <ConnectionEditor
        tabId="tab-test-1"
        meta={{ connectionId: CONN_ID, folderId: null }}
        isVisible={true}
      />
    );
  });
}

describe("ConnectionEditor — credential hint", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetRuntimeCache();
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connections: [EXISTING_CONN],
      connectionTypes: [SSH_TYPE],
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
    });

    mockedInvoke.mockImplementation(() => Promise.resolve(false));
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it("does not show 'Password saved' hint when resolve_credential returns null", async () => {
    // Regression: previously the hint appeared for any connection with savePassword=true,
    // even when no credential was actually stored. It must only appear after resolveCredential
    // confirms the credential exists.
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "resolve_credential") return Promise.resolve(null);
      return Promise.resolve(false);
    });

    render();

    // Flush the resolveCredential promise
    await act(async () => {
      await Promise.resolve();
    });

    const hint = container.querySelector('[data-testid="field-password-credential-saved"]');
    expect(hint).toBeNull();
  });

  it("shows 'Password saved' hint when resolve_credential returns a value", async () => {
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "resolve_credential") return Promise.resolve("s3cr3t");
      return Promise.resolve(false);
    });

    render();

    await act(async () => {
      await Promise.resolve();
    });

    const hint = container.querySelector('[data-testid="field-password-credential-saved"]');
    expect(hint).not.toBeNull();
  });
});
