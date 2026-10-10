/**
 * VNC-specific behavior of the schema-driven connection form (#1716):
 *
 * A VNC server listens on `5900 + display`, so the editor keeps the two fields
 * in sync — entering a display number auto-fills the port, and editing the port
 * directly clears the display. This mirrors the connect-side resolution
 * (`VncConfig::effective_port`) as an editor convenience, applied as a small
 * frontend special-case the `equals`-only schema condition cannot express.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { SettingsSchema } from "@/types/schema";
import { ConnectionSettingsForm } from "./ConnectionSettingsForm";
import { dispatchCommand, type BridgeDeps } from "@/testbridge/dispatcher";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn().mockResolvedValue(null) }));
vi.mock("@/services/api", () => ({ listSerialPorts: vi.fn().mockResolvedValue([]) }));

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

const VNC_SCHEMA: SettingsSchema = {
  groups: [
    {
      key: "connection",
      label: "Connection",
      fields: [
        { key: "host", label: "Host", fieldType: { type: "text" }, required: true },
        { key: "port", label: "Port", fieldType: { type: "port" }, required: true, default: 5900 },
      ],
    },
    {
      key: "vnc",
      label: "VNC Options",
      fields: [
        {
          key: "display",
          label: "Display Number",
          fieldType: { type: "number", min: 0, max: 255 },
          required: false,
        },
      ],
    },
  ],
};

let lastSettings: Record<string, unknown> = {};

function renderForm(settings: Record<string, unknown>, schema: SettingsSchema = VNC_SCHEMA) {
  lastSettings = { ...settings };
  act(() => {
    root.render(
      <ConnectionSettingsForm
        schema={schema}
        settings={settings}
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

async function typeInto(testId: string, text: string) {
  const deps = { ...bridgeDeps, root: container };
  await act(async () => {
    await dispatchCommand({ action: "type", testId, text }, deps);
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ConnectionSettingsForm — VNC display↔port interplay", () => {
  it("auto-fills the port to 5900 + display when the display is entered", async () => {
    renderForm({ host: "h", port: 5900 });
    await typeInto("field-display", "5");
    expect((query("field-port") as HTMLInputElement).value).toBe("5905");
    expect(lastSettings.port).toBe(5905);
  });

  it("maps display 0 to the base port 5900", async () => {
    renderForm({ host: "h", port: 5999 });
    await typeInto("field-display", "0");
    expect((query("field-port") as HTMLInputElement).value).toBe("5900");
  });

  it("clears the display when the port is edited directly", async () => {
    renderForm({ host: "h", port: 5905, display: 5 });
    await typeInto("field-port", "5910");
    expect((query("field-display") as HTMLInputElement).value).toBe("");
    // Cleared to a null-ish "no display" so the explicit port wins on connect.
    expect(lastSettings.display == null).toBe(true);
  });

  it("leaves the port untouched when the display is cleared", async () => {
    renderForm({ host: "h", port: 5905, display: 5 });
    await typeInto("field-display", "");
    expect((query("field-port") as HTMLInputElement).value).toBe("5905");
  });

  it("does not fill the port for an out-of-derivable-range display", async () => {
    renderForm({ host: "h", port: 5900 });
    // NumberInput accepts the raw digits; the derivation guards the TCP range.
    await typeInto("field-display", "60000");
    expect((query("field-port") as HTMLInputElement).value).toBe("5900");
  });
});

/**
 * #4198: the File Transfer group's notice is computed from two fields. The
 * schema (mirroring `vnc_settings_schema`) shows the info notice, or — exactly
 * when the VNC host is neither loopback nor the SSH tunnel host — a warning
 * that names where files will land.
 */
const FILE_TRANSFER_SCHEMA: SettingsSchema = {
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
        {
          key: "sshHost",
          label: "SSH Host",
          fieldType: { type: "text" },
          required: false,
          visibleWhen: { field: "useSshTunnel", equals: true },
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
          key: "fileTransferRouteNotice",
          label: "",
          description: "Files go to the SSH tunnel host (or the agent host).",
          fieldType: { type: "notice", severity: "info" },
          required: false,
          visibleWhen: {
            field: "fileTransfer",
            equals: true,
            anyOf: [
              { field: "useSshTunnel", equals: false },
              { field: "host", sameHostAs: "sshHost", equals: true },
            ],
          },
        },
        {
          key: "fileTransferHostWarning",
          label: "",
          description: "Files would go to {{sshHost}}, not to the desktop host {{host}}.",
          fieldType: { type: "notice", severity: "warning" },
          required: false,
          visibleWhen: {
            field: "fileTransfer",
            equals: true,
            allOf: [
              { field: "useSshTunnel", equals: true },
              { field: "host", sameHostAs: "sshHost", equals: false },
            ],
          },
        },
      ],
    },
  ],
};

describe("ConnectionSettingsForm — VNC file-transfer host notice (#4198)", () => {
  const info = () => query("field-fileTransferRouteNotice");
  const warning = () => query("field-fileTransferHostWarning");
  const gateway = {
    host: "10.0.4.17",
    useSshTunnel: true,
    sshHost: "bastion.corp",
    fileTransfer: true,
  };

  it("warns where files land when the SSH host is a gateway", () => {
    renderForm(gateway, FILE_TRANSFER_SCHEMA);
    expect(info()).toBeNull();
    expect(warning()?.textContent).toBe(
      "Files would go to bastion.corp, not to the desktop host 10.0.4.17."
    );
    expect(warning()?.className).toContain("settings-form__notice--warning");
  });

  it("shows the info notice when the VNC host is loopback on the SSH host", () => {
    renderForm({ ...gateway, host: "localhost" }, FILE_TRANSFER_SCHEMA);
    expect(info()).not.toBeNull();
    expect(warning()).toBeNull();
  });

  it("shows the info notice when the VNC host is the SSH host itself", () => {
    renderForm({ ...gateway, host: "Bastion.Corp." }, FILE_TRANSFER_SCHEMA);
    expect(info()).not.toBeNull();
    expect(warning()).toBeNull();
  });

  it("shows the info notice without an SSH tunnel", () => {
    renderForm({ ...gateway, useSshTunnel: false }, FILE_TRANSFER_SCHEMA);
    expect(info()).not.toBeNull();
    expect(warning()).toBeNull();
  });

  it("shows neither notice while file transfer is off", () => {
    renderForm({ ...gateway, fileTransfer: false }, FILE_TRANSFER_SCHEMA);
    expect(info()).toBeNull();
    expect(warning()).toBeNull();
  });

  it("switches live as the host is edited", async () => {
    renderForm({ ...gateway, host: "127.0.0.1" }, FILE_TRANSFER_SCHEMA);
    expect(info()).not.toBeNull();
    await typeInto("field-host", "desk.corp");
    expect(info()).toBeNull();
    expect(warning()?.textContent).toBe(
      "Files would go to bastion.corp, not to the desktop host desk.corp."
    );
  });
});

/**
 * #4402: the shared graphical field base (`shared_field_base`, used by both
 * VNC and RDP) carries the unified `connectTimeoutSecs` row. The editor is
 * schema-driven, so the row renders as a number input and edits flow into the
 * settings the desktop's graphical connect reads.
 */
const CONNECT_TIMEOUT_SCHEMA: SettingsSchema = {
  groups: [
    {
      key: "connection",
      label: "Connection",
      fields: [
        { key: "host", label: "Host", fieldType: { type: "text" }, required: true },
        { key: "port", label: "Port", fieldType: { type: "port" }, required: true, default: 5900 },
        {
          key: "connectTimeoutSecs",
          label: "Connect Timeout (s)",
          fieldType: { type: "number", min: 1, max: 600 },
          required: false,
          default: 30,
          placeholder: "30",
        },
      ],
    },
  ],
};

describe("ConnectionSettingsForm — graphical connect timeout (#4402)", () => {
  it("renders the connect timeout row with its saved value", () => {
    renderForm({ host: "h", port: 5900, connectTimeoutSecs: 30 }, CONNECT_TIMEOUT_SCHEMA);
    const input = query("field-connectTimeoutSecs") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe("30");
    expect(container.textContent).toContain("Connect Timeout (s)");
  });

  it("writes an edited timeout back to the unified settings key", async () => {
    renderForm({ host: "h", port: 5900, connectTimeoutSecs: 30 }, CONNECT_TIMEOUT_SCHEMA);
    await typeInto("field-connectTimeoutSecs", "45");
    expect(lastSettings.connectTimeoutSecs).toBe(45);
  });
});
