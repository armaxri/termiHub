/**
 * The SSH "Untrusted X11 forwarding" option (#5585) in the schema-driven
 * connection form:
 *
 * - it only shows while X11 forwarding is on (schema `visibleWhen`);
 * - it starts at the schema default (the backend's `DEFAULT_X11_UNTRUSTED`)
 *   and toggling it reports `x11Untrusted`;
 * - a new connection gets the schema default;
 * - its timeout (#5600) shows only while untrusted forwarding is on, and an
 *   out-of-range value blocks Save with a clear error.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { flushMacrotask } from "@/test/flushAsync";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { SettingsSchema } from "@/types/schema";
import type { ConnectionTypeInfo } from "@/services/api";
import { ConnectionSettingsForm } from "./ConnectionSettingsForm";
import { buildTypeDefaults } from "@/components/ConnectionEditor/connectionTypeDefaults";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn().mockResolvedValue(null) }));
vi.mock("@/services/api", () => ({ listSerialPorts: vi.fn().mockResolvedValue([]) }));

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

/** The X11 part of the SSH schema's Advanced group, with `untrustedDefault`. */
function sshSchema(untrustedDefault: boolean): SettingsSchema {
  return {
    groups: [
      {
        key: "advanced",
        label: "Advanced",
        fields: [
          {
            key: "enableX11Forwarding",
            label: "X11 forwarding",
            fieldType: { type: "boolean" },
            required: false,
            default: false,
          },
          {
            key: "x11Untrusted",
            label: "Untrusted X11 forwarding",
            description: "Limit what remote programs can do on your screen",
            helpText: "Trusted forwarding (off) gives remote programs full access.",
            fieldType: { type: "boolean" },
            required: false,
            default: untrustedDefault,
            visibleWhen: { field: "enableX11Forwarding", equals: true },
          },
          {
            key: "x11UntrustedTimeoutMins",
            label: "Untrusted X11 timeout (min)",
            description: "How long after connecting new remote windows can open",
            fieldType: { type: "number", min: 0, max: 1440 },
            required: false,
            placeholder: "20",
            visibleWhen: {
              field: "enableX11Forwarding",
              equals: true,
              allOf: [{ field: "x11Untrusted", equals: true }],
            },
          },
        ],
      },
    ],
  };
}

function renderForm(
  settings: Record<string, unknown>,
  onChange = vi.fn(),
  untrustedDefault = false
) {
  act(() => {
    root.render(
      <ConnectionSettingsForm
        schema={sshSchema(untrustedDefault)}
        settings={settings}
        onChange={onChange}
      />
    );
  });
  return onChange;
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

describe("ConnectionSettingsForm — untrusted X11 forwarding (#5585)", () => {
  it("is hidden while X11 forwarding is off", () => {
    renderForm({ enableX11Forwarding: false });
    expect(query("field-enableX11Forwarding")).toBeTruthy();
    expect(query("field-x11Untrusted")).toBeNull();
  });

  it("shows with its plain-words description once X11 forwarding is on", () => {
    renderForm({ enableX11Forwarding: true });
    const toggle = query("field-x11Untrusted");
    expect(toggle).toBeTruthy();
    expect(toggle?.getAttribute("aria-label")).toBe("Untrusted X11 forwarding");
    expect(container.textContent).toContain("Limit what remote programs can do on your screen");
    expect(query("field-x11Untrusted-help")).toBeTruthy();
  });

  it("starts at the schema default", () => {
    renderForm({ enableX11Forwarding: true });
    expect(query("field-x11Untrusted")?.getAttribute("aria-checked")).toBe("false");
    act(() => root.unmount());
    root = createRoot(container);
    renderForm({ enableX11Forwarding: true }, vi.fn(), true);
    expect(query("field-x11Untrusted")?.getAttribute("aria-checked")).toBe("true");
  });

  it("reports x11Untrusted when toggled on", () => {
    const onChange = renderForm({ enableX11Forwarding: true, x11Untrusted: false });
    act(() => {
      query("field-x11Untrusted")?.click();
    });
    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls[onChange.mock.calls.length - 1][0] as Record<string, unknown>;
    expect(last.x11Untrusted).toBe(true);
    expect(last.enableX11Forwarding).toBe(true);
  });

  it("a new SSH connection gets the schema default", () => {
    for (const untrustedDefault of [false, true]) {
      const info = { typeId: "ssh", schema: sshSchema(untrustedDefault) } as ConnectionTypeInfo;
      expect(buildTypeDefaults(info, {}).x11Untrusted).toBe(untrustedDefault);
    }
  });
});

describe("ConnectionSettingsForm — untrusted X11 timeout (#5600)", () => {
  /** Render `settings` on a fresh root; the last validity report. */
  async function renderWithValidity(settings: Record<string, unknown>) {
    act(() => root.unmount());
    root = createRoot(container);
    const onValidity = vi.fn();
    await act(async () => {
      root.render(
        <ConnectionSettingsForm
          schema={sshSchema(false)}
          settings={settings}
          onChange={vi.fn()}
          onValidityChange={onValidity}
        />
      );
    });
    await act(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
      await flushMacrotask();
    });
    return onValidity.mock.calls[onValidity.mock.calls.length - 1] as [
      boolean,
      Record<string, string>,
    ];
  }

  it("is hidden unless both X11 forwarding and untrusted forwarding are on", () => {
    renderForm({ enableX11Forwarding: false, x11Untrusted: true });
    expect(query("field-x11UntrustedTimeoutMins")).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    renderForm({ enableX11Forwarding: true, x11Untrusted: false });
    expect(query("field-x11UntrustedTimeoutMins")).toBeNull();
  });

  it("shows with the default as placeholder once untrusted forwarding is on", () => {
    renderForm({ enableX11Forwarding: true, x11Untrusted: true });
    const input = query("field-x11UntrustedTimeoutMins") as HTMLInputElement | null;
    expect(input).toBeTruthy();
    expect(input?.placeholder).toBe("20");
    expect(input?.value).toBe("");
    expect(container.textContent).toContain(
      "How long after connecting new remote windows can open"
    );
  });

  it("accepts empty, 0 (no limit) and the maximum", async () => {
    for (const mins of [undefined, 0, 1, 1440]) {
      const [valid, errors] = await renderWithValidity({
        enableX11Forwarding: true,
        x11Untrusted: true,
        x11UntrustedTimeoutMins: mins,
      });
      expect(valid, String(mins)).toBe(true);
      expect(errors).not.toHaveProperty("x11UntrustedTimeoutMins");
    }
  });

  it("rejects an out-of-range timeout with a clear error", async () => {
    const [tooLong, longErrors] = await renderWithValidity({
      enableX11Forwarding: true,
      x11Untrusted: true,
      x11UntrustedTimeoutMins: 1441,
    });
    expect(tooLong).toBe(false);
    expect(longErrors.x11UntrustedTimeoutMins).toBe("Must be at most 1440");
    const [negative, negativeErrors] = await renderWithValidity({
      enableX11Forwarding: true,
      x11Untrusted: true,
      x11UntrustedTimeoutMins: -1,
    });
    expect(negative).toBe(false);
    expect(negativeErrors.x11UntrustedTimeoutMins).toBe("Must be at least 0");
  });

  it("does not block Save while hidden, whatever it holds", async () => {
    const [valid] = await renderWithValidity({
      enableX11Forwarding: true,
      x11Untrusted: false,
      x11UntrustedTimeoutMins: 99999,
    });
    expect(valid).toBe(true);
  });
});
