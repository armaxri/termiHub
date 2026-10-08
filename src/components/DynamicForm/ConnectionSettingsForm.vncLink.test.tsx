/**
 * #4194: a direct VNC connection can link a saved SSH connection as its file
 * route. The schema (mirroring `vnc_settings_schema`) declares a
 * `savedConnection` picker shown only for a direct connection with file
 * transfer on, and a warning notice computed from the linked connection's host
 * (`fileTransferVia.host`, derived by the form from the saved connections).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { SettingsSchema } from "@/types/schema";
import type { SavedConnection } from "@/types/connection";
import { ConnectionSettingsForm } from "./ConnectionSettingsForm";
import { dispatchCommand, type BridgeDeps } from "@/testbridge/dispatcher";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn().mockResolvedValue(null) }));
vi.mock("@/services/api", () => ({ listSerialPorts: vi.fn().mockResolvedValue([]) }));

let container: HTMLDivElement;
let root: Root;
let lastSettings: Record<string, unknown> = {};

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

const SCHEMA: SettingsSchema = {
  groups: [
    {
      key: "connection",
      label: "Connection",
      fields: [{ key: "host", label: "Host", fieldType: { type: "text" }, required: true }],
    },
    {
      key: "sshTunnel",
      label: "SSH Tunnel",
      fields: [
        {
          key: "useSshTunnel",
          label: "Use SSH Tunnel",
          fieldType: { type: "boolean" },
          required: false,
          default: false,
        },
      ],
    },
    {
      key: "fileTransfer",
      label: "File Transfer",
      fields: [
        {
          key: "fileTransfer",
          label: "Allow file transfer",
          fieldType: { type: "boolean" },
          required: false,
          default: false,
        },
        {
          key: "fileTransferVia",
          label: "File transfer via",
          fieldType: { type: "savedConnection", connectionType: "ssh", matchHostField: "host" },
          required: false,
          visibleWhen: {
            field: "fileTransfer",
            equals: true,
            allOf: [{ field: "useSshTunnel", equals: false }],
          },
        },
        {
          key: "fileTransferViaHostWarning",
          label: "",
          description:
            "Files would go to {{fileTransferVia.host}}, not to the desktop host {{host}}.",
          fieldType: { type: "notice", severity: "warning" },
          required: false,
          visibleWhen: {
            field: "fileTransfer",
            equals: true,
            allOf: [
              { field: "useSshTunnel", equals: false },
              { field: "host", sameNameAs: "fileTransferVia.host", equals: false },
            ],
          },
        },
      ],
    },
  ],
};

function conn(id: string, type: string, host: string): SavedConnection {
  return {
    id,
    name: id.split("/").pop() ?? id,
    config: { type, config: { host } },
    folderId: null,
  };
}

const CONNECTIONS: SavedConnection[] = [
  conn("Lab/Tiger", "ssh", "tiger-box"),
  conn("Lab/Bastion", "ssh", "bastion.corp"),
  conn("Lab/Telnet", "telnet", "office-pc"),
];

function renderForm(settings: Record<string, unknown>, connections = CONNECTIONS) {
  lastSettings = { ...settings };
  act(() => {
    root.render(
      <ConnectionSettingsForm
        schema={SCHEMA}
        settings={settings}
        savedConnections={connections}
        onChange={(s) => {
          lastSettings = s;
        }}
      />
    );
  });
}

const bridgeDeps: BridgeDeps = {
  root: document.body,
  readTerminal: () => undefined,
  scrollTerminal: () => false,
  getTerminalViewport: () => undefined,
  getActiveTabId: () => undefined,
  getState: () => ({}),
  sendTerminalInput: async () => false,
  resizeWindow: async () => {},
  screenshot: async () => "data:image/png;base64,AAAA",
  emitEvent: async () => {},
};

async function select(testId: string, value: string) {
  let result: unknown;
  await act(async () => {
    result = await dispatchCommand({ action: "select", testId, value }, bridgeDeps);
  });
  return result as { ok: boolean };
}

const picker = () => query("field-fileTransferVia");
const warning = () => query("field-fileTransferViaHostWarning");
const direct = { host: "office-pc", useSshTunnel: false, fileTransfer: true };

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ConnectionSettingsForm — VNC linked SSH file route (#4194)", () => {
  it("offers the picker only for a direct connection with file transfer on", () => {
    renderForm({ ...direct, fileTransferVia: "" });
    expect(picker()).not.toBeNull();
    renderForm({ ...direct, useSshTunnel: true, fileTransferVia: "" });
    expect(picker()).toBeNull();
    renderForm({ ...direct, fileTransfer: false, fileTransferVia: "" });
    expect(picker()).toBeNull();
  });

  it("lists saved SSH connections only, plus None", async () => {
    renderForm({ ...direct, fileTransferVia: "" });
    expect(picker()?.textContent).toContain("None");
    expect((await select("field-fileTransferVia", "Lab/Bastion")).ok).toBe(true);
    expect(lastSettings.fileTransferVia).toBe("Lab/Bastion");
    expect((await select("field-fileTransferVia", "Lab/Telnet")).ok).toBe(false);
  });

  it("stores None as an empty link", async () => {
    renderForm({ ...direct, fileTransferVia: "Lab/Bastion" });
    expect((await select("field-fileTransferVia", "__none__")).ok).toBe(true);
    expect(lastSettings.fileTransferVia).toBe("");
  });

  it("preselects the SSH connection on the VNC host", () => {
    renderForm({ ...direct, host: "Tiger-Box" });
    expect(lastSettings.fileTransferVia).toBe("Lab/Tiger");
    expect(picker()?.textContent).toContain("Tiger");
  });

  it("does not preselect over an explicit None or without a matching host", () => {
    renderForm({ ...direct, host: "tiger-box", fileTransferVia: "" });
    expect(lastSettings.fileTransferVia).toBe("");
    renderForm({ ...direct, host: "nowhere" });
    expect(lastSettings.fileTransferVia ?? null).toBeNull();
  });

  it("warns, naming both hosts, when the linked host is not the VNC host", () => {
    renderForm({ ...direct, fileTransferVia: "Lab/Bastion" });
    expect(warning()?.textContent).toBe(
      "Files would go to bastion.corp, not to the desktop host office-pc."
    );
    expect(warning()?.className).toContain("settings-form__notice--warning");
  });

  it("does not warn when the linked connection is on the VNC host", () => {
    renderForm({ ...direct, host: "TIGER-BOX.", fileTransferVia: "Lab/Tiger" });
    expect(warning()).toBeNull();
  });

  it("warns for a loopback VNC host: that desktop is this computer", () => {
    renderForm({ ...direct, host: "localhost", fileTransferVia: "Lab/Tiger" });
    expect(warning()?.textContent).toContain("tiger-box");
  });

  it("flags a link whose SSH connection was deleted, without warning about hosts", () => {
    renderForm({ ...direct, fileTransferVia: "Lab/Gone" });
    expect(query("field-fileTransferVia-missing")?.textContent).toContain("no longer exists");
    expect(warning()).toBeNull();
  });
});
