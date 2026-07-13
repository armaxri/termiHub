/**
 * FTP-specific behaviors of the schema-driven connection form:
 *
 * - the display-only insecure-FTP `notice` field is visible only while
 *   TLS Mode is "none" (schema `visibleWhen`);
 * - switching TLS Mode auto-adjusts the control port default (990 for implicit
 *   FTPS, 21 otherwise) — a frontend special-case the `equals`-only schema
 *   condition cannot express.
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

const FTP_SCHEMA: SettingsSchema = {
  groups: [
    {
      key: "server",
      label: "Server",
      fields: [
        { key: "host", label: "Host", fieldType: { type: "text" }, required: true },
        { key: "port", label: "Port", fieldType: { type: "port" }, required: true, default: 21 },
      ],
    },
    {
      key: "security",
      label: "Security",
      fields: [
        {
          key: "tlsMode",
          label: "TLS Mode",
          fieldType: {
            type: "select",
            options: [
              { value: "none", label: "None (plain FTP)" },
              { value: "explicit", label: "Explicit (STARTTLS)" },
              { value: "implicit", label: "Implicit" },
            ],
          },
          required: true,
          default: "none",
        },
        {
          key: "tlsWarning",
          label: "",
          fieldType: { type: "notice", severity: "warning" },
          required: false,
          description: "Plain FTP transmits credentials and data in cleartext.",
          visibleWhen: { field: "tlsMode", equals: "none" },
        },
      ],
    },
  ],
};

function renderForm(settings: Record<string, unknown>) {
  act(() => {
    root.render(
      <ConnectionSettingsForm schema={FTP_SCHEMA} settings={settings} onChange={vi.fn()} />
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
};

async function selectTlsMode(value: string) {
  const deps = { ...bridgeDeps, root: container };
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await dispatchCommand({ action: "select", testId: "field-tlsMode", value }, deps);
    });
  }
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

describe("ConnectionSettingsForm — FTP", () => {
  it("shows the TLS warning notice only when tlsMode is none", () => {
    renderForm({ tlsMode: "none", port: 21 });
    expect(query("field-tlsWarning")).toBeTruthy();
    expect(query("field-tlsWarning")?.textContent).toContain("cleartext");
  });

  it("hides the TLS warning notice for FTPS", () => {
    renderForm({ tlsMode: "explicit", port: 21 });
    expect(query("field-tlsWarning")).toBeNull();
  });

  it("auto-adjusts the port to 990 when switching to implicit FTPS", async () => {
    renderForm({ tlsMode: "none", port: 21 });
    await selectTlsMode("implicit");
    expect((query("field-port") as HTMLInputElement).value).toBe("990");
  });

  it("auto-adjusts the port back to 21 when leaving implicit FTPS", async () => {
    renderForm({ tlsMode: "implicit", port: 990 });
    await selectTlsMode("explicit");
    expect((query("field-port") as HTMLInputElement).value).toBe("21");
  });

  it("preserves a custom port when switching TLS mode", async () => {
    renderForm({ tlsMode: "none", port: 2121 });
    await selectTlsMode("implicit");
    expect((query("field-port") as HTMLInputElement).value).toBe("2121");
  });
});
