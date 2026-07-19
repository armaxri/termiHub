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

function renderForm(settings: Record<string, unknown>) {
  lastSettings = { ...settings };
  act(() => {
    root.render(
      <ConnectionSettingsForm
        schema={VNC_SCHEMA}
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
