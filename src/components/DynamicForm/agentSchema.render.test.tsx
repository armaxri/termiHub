import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ConnectionSettingsForm } from "./ConnectionSettingsForm";
import { AGENT_SCHEMA } from "./agentSchema";
import type { RemoteAgentConfig } from "@/types/terminal";

// Mock Tauri dialog + KeyPathInput so the schema renders in jsdom.
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn().mockResolvedValue(null) }));
vi.mock("@/services/api", () => ({ listSerialPorts: vi.fn().mockResolvedValue([]) }));
vi.mock("@/components/Settings/KeyPathInput", () => ({
  KeyPathInput: ({ value }: { value: string }) => (
    <input data-testid="mock-key-path-input" value={value} readOnly />
  ),
}));

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function renderAgentForm(settings: Record<string, unknown>) {
  act(() => {
    root.render(
      <ConnectionSettingsForm schema={AGENT_SCHEMA} settings={settings} onChange={vi.fn()} />
    );
  });
}

/**
 * WA-FE-002: the connection editor must not render the non-functional
 * "Allow agent self-update" toggle, and must still load configs that were saved
 * while it existed.
 */
describe("AGENT_SCHEMA connection form (WA-FE-002)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("does not render the self-update toggle", () => {
    renderAgentForm({ host: "h", port: 22, username: "pi", authMethod: "password" });
    // The Updates group and its strategy select still render...
    expect(query("dynamic-field-updateStrategy")).toBeTruthy();
    // ...but the non-functional self-update toggle must be gone.
    expect(query("dynamic-field-allowSelfUpdate")).toBeNull();
  });

  it("loads an existing config carrying the removed values without error", () => {
    const stored: RemoteAgentConfig = {
      host: "192.168.1.100",
      port: 22,
      username: "pi",
      authMethod: "password",
      allowSelfUpdate: true,
      updateStrategy: "deferred",
    };
    // Rendering must not throw even though "deferred"/allowSelfUpdate are no
    // longer offered, and the toggle still must not appear.
    renderAgentForm(stored as unknown as Record<string, unknown>);
    expect(query("connection-settings-form")).toBeTruthy();
    expect(query("dynamic-field-allowSelfUpdate")).toBeNull();
  });
});
