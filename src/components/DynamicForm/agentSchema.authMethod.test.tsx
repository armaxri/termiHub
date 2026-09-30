import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ConnectionSettingsForm } from "./ConnectionSettingsForm";
import { AGENT_SCHEMA } from "./agentSchema";

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

function authMethodOptions(): string[] {
  const field = AGENT_SCHEMA.groups.flatMap((g) => g.fields).find((f) => f.key === "authMethod");
  if (field?.fieldType.type !== "select") throw new Error("authMethod is not a select");
  return field.fieldType.options.map((o) => o.value);
}

/**
 * #3377: the remote-agent host's SSH hop can use keyboard-interactive auth
 * (OTP / 2FA), answered in the in-app prompt at connect time — so the form
 * offers it and asks for no password up front.
 */
describe("AGENT_SCHEMA auth method (#3377)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("offers keyboard-interactive alongside password, key and agent", () => {
    expect(authMethodOptions()).toEqual(["password", "key", "agent", "keyboard-interactive"]);
  });

  it("asks for no password, key path or saved secret with keyboard-interactive", () => {
    renderAgentForm({ host: "h", port: 22, username: "ops", authMethod: "keyboard-interactive" });
    expect(query("dynamic-field-authMethod")).toBeTruthy();
    expect(query("dynamic-field-password")).toBeNull();
    expect(query("dynamic-field-savePassword")).toBeNull();
    expect(query("dynamic-field-keyPath")).toBeNull();
  });

  it("still shows the password field for password auth", () => {
    renderAgentForm({ host: "h", port: 22, username: "ops", authMethod: "password" });
    expect(query("dynamic-field-password")).toBeTruthy();
  });
});
