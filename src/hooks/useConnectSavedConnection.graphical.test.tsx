/**
 * Direct (non-agent) VNC/RDP connections honour "Save password" (#3818): a
 * saved password is read from this computer's credential store on connect, so
 * a reconnect opens without a prompt; with nothing stored yet the user is
 * asked once, and the prompt's Save box keeps the answer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { useConnectSavedConnection } from "./useConnectSavedConnection";
import type { SavedConnection, ConnectionTypeInfo } from "@/types/connection";
import { resolveCredential, createTerminal, storeCredential } from "@/services/api";
import { toast } from "@/components/ui";

vi.mock("@/services/api", () => ({
  createTerminal: vi.fn(() => Promise.resolve("session-1")),
  removeCredential: vi.fn(() => Promise.resolve()),
  storeCredential: vi.fn(() => Promise.resolve()),
  resolveCredential: vi.fn(() => Promise.resolve(null)),
  isSshKeyEncrypted: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("@/utils/frontendLog", () => ({
  frontendLog: vi.fn(),
  frontendError: vi.fn(),
}));

const mockedResolveCredential = vi.mocked(resolveCredential);
const mockedCreateTerminal = vi.mocked(createTerminal);
const mockedStoreCredential = vi.mocked(storeCredential);

function graphicalType(typeId: string): ConnectionTypeInfo {
  return {
    typeId,
    displayName: typeId.toUpperCase(),
    icon: "",
    schema: { groups: [] },
    capabilities: {
      monitoring: false,
      fileBrowser: false,
      resize: true,
      persistent: false,
      terminal: false,
      graphical: true,
    },
  };
}

function makeDesktop(
  type: "vnc" | "rdp",
  settings: Record<string, unknown>,
  sourceFile?: string
): SavedConnection {
  return {
    id: `${type}-desk`,
    name: `Desk ${type}`,
    folderId: null,
    config: { type, config: { host: "desk.example.com", port: 5900, ...settings } },
    ...(sourceFile ? { sourceFile } : {}),
  };
}

let container: HTMLDivElement;
let root: Root;
let addTabSpy: ReturnType<typeof vi.fn>;

async function renderHook(): Promise<ReturnType<typeof useConnectSavedConnection>> {
  let api: ReturnType<typeof useConnectSavedConnection> | undefined;
  function Harness() {
    api = useConnectSavedConnection();
    return null;
  }
  await act(async () => {
    root.render(React.createElement(Harness));
  });
  return api!;
}

/** Let the connect flow run up to its prompt. */
async function flush() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
  mockedResolveCredential.mockResolvedValue(null);
  addTabSpy = vi.fn(() => "tab-1");
  vi.spyOn(toast, "loading").mockReturnValue("connecting-toast");
  vi.spyOn(toast, "dismiss").mockImplementation(() => {});
  vi.spyOn(toast, "info").mockReturnValue("info-toast");
  useAppStore.setState({
    ...useAppStore.getInitialState(),
    addTab: addTabSpy as unknown as ReturnType<typeof useAppStore.getState>["addTab"],
    credentialStoreStatus: { mode: "os_keychain", status: "unlocked" },
    connectionTypes: [graphicalType("vnc"), graphicalType("rdp")],
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
});

describe("useConnectSavedConnection — direct VNC/RDP password (#3818)", () => {
  it.each(["vnc", "rdp"] as const)(
    "reconnects a saved %s password from the store without a prompt",
    async (type) => {
      mockedResolveCredential.mockResolvedValue("stored-secret");
      const { connect } = await renderHook();
      await act(async () => {
        await connect(makeDesktop(type, { savePassword: true }));
      });

      expect(mockedResolveCredential).toHaveBeenCalledWith(`${type}-desk`, "password", null);
      expect(useAppStore.getState().passwordPromptOpen).toBe(false);
      expect(addTabSpy).toHaveBeenCalledWith(
        `Desk ${type}`,
        type,
        expect.objectContaining({
          config: expect.objectContaining({ password: "stored-secret" }),
        }),
        expect.objectContaining({ contentType: "remote-desktop", connectionId: `${type}-desk` })
      );
      // A graphical session is not a terminal session.
      expect(mockedCreateTerminal).not.toHaveBeenCalled();
    }
  );

  it("looks the password up in the connection's own file scope", async () => {
    mockedResolveCredential.mockResolvedValue("stored-secret");
    const { connect } = await renderHook();
    await act(async () => {
      await connect(makeDesktop("rdp", { savePassword: true }, "/shared/team.json"));
    });
    expect(mockedResolveCredential).toHaveBeenCalledWith(
      "rdp-desk",
      "password",
      "/shared/team.json"
    );
  });

  it("prompts once when nothing is stored yet and saves the answer when asked to", async () => {
    const { connect } = await renderHook();
    await act(async () => {
      void connect(makeDesktop("vnc", { savePassword: true }));
      await flush();
    });
    expect(useAppStore.getState().passwordPromptOpen).toBe(true);
    expect(addTabSpy).not.toHaveBeenCalled();

    await act(async () => {
      useAppStore.getState().submitPassword("typed-secret", true);
      await flush();
    });

    expect(mockedStoreCredential).toHaveBeenCalledWith(
      "vnc-desk",
      "password",
      "typed-secret",
      null
    );
    expect(addTabSpy).toHaveBeenCalledWith(
      "Desk vnc",
      "vnc",
      expect.objectContaining({
        config: expect.objectContaining({ password: "typed-secret" }),
      }),
      expect.objectContaining({ contentType: "remote-desktop" })
    );
  });

  it("opens without a prompt or lookup when the password is not saved", async () => {
    // A VNC server may need no password at all: without "Save password" the
    // connect is unchanged.
    const { connect } = await renderHook();
    await act(async () => {
      await connect(makeDesktop("vnc", {}));
    });
    expect(mockedResolveCredential).not.toHaveBeenCalled();
    expect(useAppStore.getState().passwordPromptOpen).toBe(false);
    expect(addTabSpy).toHaveBeenCalledWith(
      "Desk vnc",
      "vnc",
      expect.objectContaining({
        config: expect.not.objectContaining({ password: expect.anything() }),
      }),
      expect.objectContaining({ contentType: "remote-desktop" })
    );
  });

  it("cancels the connect when the prompt is dismissed", async () => {
    const { connect } = await renderHook();
    await act(async () => {
      void connect(makeDesktop("rdp", { savePassword: true }));
      await flush();
    });
    await act(async () => {
      useAppStore.getState().dismissPasswordPrompt();
      await flush();
    });
    expect(addTabSpy).not.toHaveBeenCalled();
    expect(mockedStoreCredential).not.toHaveBeenCalled();
  });
});
