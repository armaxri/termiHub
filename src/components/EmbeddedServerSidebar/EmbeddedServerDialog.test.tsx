import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";

vi.mock("@/services/embeddedServerApi", () => ({
  listNetworkInterfaces: vi.fn(() =>
    Promise.resolve([
      { name: "Loopback", addr: "127.0.0.1" },
      { name: "All Interfaces", addr: "0.0.0.0" },
    ])
  ),
}));

import { EmbeddedServerDialog } from "./EmbeddedServerDialog";
import type { EmbeddedServerConfig } from "@/types/embeddedServer";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

function typeInto(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const baseProps = {
  open: true,
  onOpenChange: () => {},
  config: null,
  onSave: (_config: EmbeddedServerConfig): boolean => true,
};

describe("EmbeddedServerDialog", () => {
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

  it("renders nothing when closed", () => {
    render(<EmbeddedServerDialog {...baseProps} open={false} />);
    expect(document.querySelector('[data-testid="server-dialog-name"]')).toBeNull();
  });

  it("renders through the Modal primitive with a token'd name Input and Select bind-host", () => {
    render(<EmbeddedServerDialog {...baseProps} />);
    expect(document.querySelector(".ui-modal")).toBeTruthy();
    const name = document.querySelector('[data-testid="server-dialog-name"]') as HTMLInputElement;
    expect(name.classList.contains("ui-input")).toBe(true);
    // Bind host is the Select primitive (Radix skin): a trigger button carrying
    // the base class, with its value mirrored to `data-value`.
    const bind = document.querySelector('[data-testid="server-dialog-bind-host"]');
    expect(bind?.classList.contains("ui-select__trigger")).toBe(true);
    expect(bind?.getAttribute("data-value")).toBe("127.0.0.1");
  });

  it("Save is disabled until name + root are set, then fires onSave with the config", async () => {
    // onSave resolves true (saved) so the dialog closes; a false/rejected result
    // keeps it open (covered by EmbeddedServerSidebar's feedback tests).
    const onSave = vi.fn((_config: EmbeddedServerConfig) => Promise.resolve(true));
    const onOpenChange = vi.fn();
    render(<EmbeddedServerDialog {...baseProps} onSave={onSave} onOpenChange={onOpenChange} />);

    const saveBtn = document.querySelector(
      '[data-testid="server-dialog-save"]'
    ) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);

    typeInto(
      document.querySelector('[data-testid="server-dialog-name"]') as HTMLInputElement,
      "Firmware"
    );
    typeInto(
      document.querySelector('[data-testid="server-dialog-root"]') as HTMLInputElement,
      "/srv/fw"
    );

    expect(saveBtn.disabled).toBe(false);
    await act(async () => {
      saveBtn.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toMatchObject({
      name: "Firmware",
      rootDirectory: "/srv/fw",
      serverType: "http",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("selecting the 0.0.0.0 bind address opens the LAN security warning", () => {
    render(<EmbeddedServerDialog {...baseProps} />);
    const bind = document.querySelector(
      '[data-testid="server-dialog-bind-host"]'
    ) as HTMLButtonElement;

    // Open the Radix Select and pick the 0.0.0.0 option — the migrated
    // `onChange` must still route through `handleBindHostChange` and intercept
    // the all-interfaces address to raise the LAN warning (regression for #1074).
    for (let i = 0; i < 3 && !document.querySelector('[data-testid="lan-warning-confirm"]'); i++) {
      act(() => {
        bind.focus();
        bind.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
        );
      });
      const option = document.querySelector(
        '.ui-select__item[data-value="0.0.0.0"]'
      ) as HTMLElement | null;
      if (option) {
        act(() => {
          option.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
          option.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
          option.click();
        });
      }
    }

    expect(document.querySelector('[data-testid="lan-warning-confirm"]')).toBeTruthy();
    // And the bind host must NOT have committed to 0.0.0.0 until confirmed.
    expect(bind.getAttribute("data-value")).toBe("127.0.0.1");
  });

  it("renders the port as a token'd number input defaulting to the protocol port", () => {
    render(<EmbeddedServerDialog {...baseProps} />);
    const port = document.querySelector('[data-testid="server-dialog-port"]') as HTMLInputElement;
    expect(port.type).toBe("number");
    expect(port.classList.contains("ui-input")).toBe(true);
    expect(port.value).toBe("8080");
  });

  it("editing the port carries the new number into the saved config", async () => {
    const onSave = vi.fn((_config: EmbeddedServerConfig) => Promise.resolve(true));
    render(<EmbeddedServerDialog {...baseProps} onSave={onSave} />);

    typeInto(
      document.querySelector('[data-testid="server-dialog-name"]') as HTMLInputElement,
      "Firmware"
    );
    typeInto(
      document.querySelector('[data-testid="server-dialog-root"]') as HTMLInputElement,
      "/srv/fw"
    );
    typeInto(
      document.querySelector('[data-testid="server-dialog-port"]') as HTMLInputElement,
      "9000"
    );

    await act(async () => {
      (document.querySelector('[data-testid="server-dialog-save"]') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onSave.mock.calls[0][0]).toMatchObject({ port: 9000 });
  });

  it("clearing the port keeps it blank and blocks Save (#1453)", () => {
    render(<EmbeddedServerDialog {...baseProps} />);

    typeInto(
      document.querySelector('[data-testid="server-dialog-name"]') as HTMLInputElement,
      "Firmware"
    );
    typeInto(
      document.querySelector('[data-testid="server-dialog-root"]') as HTMLInputElement,
      "/srv/fw"
    );

    const saveBtn = document.querySelector(
      '[data-testid="server-dialog-save"]'
    ) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);

    const port = document.querySelector('[data-testid="server-dialog-port"]') as HTMLInputElement;
    typeInto(port, "");
    // The cleared field stays blank rather than snapping back to the old port,
    // and the invalid (missing) port blocks Save.
    expect(port.value).toBe("");
    expect(saveBtn.disabled).toBe(true);
  });
});
