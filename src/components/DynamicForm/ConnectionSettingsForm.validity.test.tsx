/**
 * Tests for ConnectionSettingsForm validity reporting (#1357).
 *
 * The form now reports overall client-side validity plus a per-field error map
 * upward via `onValidityChange`, so the ConnectionEditor can block Save on
 * invalid input rather than deferring to a connect-time backend error. Only
 * visible fields count — a required field hidden by `visibleWhen` must not block.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { flushMacrotask } from "@/test/flushAsync";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { SettingsSchema } from "@/types/schema";
import { ConnectionSettingsForm } from "./ConnectionSettingsForm";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn().mockResolvedValue(null) }));
vi.mock("@/services/api", () => ({ listSerialPorts: vi.fn().mockResolvedValue([]) }));

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await flushMacrotask();
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const SCHEMA: SettingsSchema = {
  groups: [
    {
      key: "connection",
      label: "Connection",
      fields: [
        { key: "host", label: "Host", fieldType: { type: "text" }, required: true },
        { key: "port", label: "Port", fieldType: { type: "port" }, required: true, default: 22 },
      ],
    },
  ],
};

describe("ConnectionSettingsForm — validity reporting", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("reports invalid with a per-field error when a required field is empty", async () => {
    const onValidity = vi.fn();
    await act(async () => {
      root.render(
        <ConnectionSettingsForm
          schema={SCHEMA}
          settings={{ port: 22 }}
          onChange={() => {}}
          onValidityChange={onValidity}
        />
      );
    });
    await flush();

    const last = onValidity.mock.calls[onValidity.mock.calls.length - 1];
    expect(last[0]).toBe(false);
    expect(last[1]).toHaveProperty("host");
  });

  it("reports valid once all required fields are filled", async () => {
    const onValidity = vi.fn();
    await act(async () => {
      root.render(
        <ConnectionSettingsForm
          schema={SCHEMA}
          settings={{ host: "example.com", port: 22 }}
          onChange={() => {}}
          onValidityChange={onValidity}
        />
      );
    });
    await flush();

    expect(onValidity.mock.calls[onValidity.mock.calls.length - 1][0]).toBe(true);
  });

  it("flips to invalid when a required field is cleared", async () => {
    const onValidity = vi.fn();
    await act(async () => {
      root.render(
        <ConnectionSettingsForm
          schema={SCHEMA}
          settings={{ host: "example.com", port: 22 }}
          onChange={() => {}}
          onValidityChange={onValidity}
        />
      );
    });
    await flush();
    expect(onValidity.mock.calls[onValidity.mock.calls.length - 1][0]).toBe(true);

    const hostInput = container.querySelector<HTMLInputElement>('[data-testid="field-host"]')!;
    await act(async () => setInputValue(hostInput, ""));
    await flush();

    expect(onValidity.mock.calls[onValidity.mock.calls.length - 1][0]).toBe(false);
  });
});
