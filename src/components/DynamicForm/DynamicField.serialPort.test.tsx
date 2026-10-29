import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { listSerialPorts } from "@/services/api";
import type { SettingsField } from "@/types/schema";
import { DynamicField } from "./DynamicField";
import { SERIAL_PORT_RESCAN_INTERVAL_MS } from "./useSerialPortRescan";

vi.mock("@/services/api", () => ({ listSerialPorts: vi.fn() }));

const lister = listSerialPorts as ReturnType<typeof vi.fn>;

const serialPortField: SettingsField = {
  key: "port",
  label: "Port",
  fieldType: { type: "serialPort" },
  required: true,
};

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function optionValues(): string[] {
  const input = query("field-port") as HTMLInputElement;
  const datalist = container.querySelector(`#${input.getAttribute("list")}`) as HTMLDataListElement;
  return Array.from(datalist.options).map((o) => o.value);
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function render(
  value: string,
  onChange: (v: unknown) => void = vi.fn(),
  availablePorts?: string[]
): Promise<void> {
  act(() => {
    root.render(
      <DynamicField
        field={serialPortField}
        value={value}
        onChange={onChange}
        availablePorts={availablePorts}
      />
    );
  });
  await settle();
}

async function rescan(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(SERIAL_PORT_RESCAN_INTERVAL_MS);
  });
  await settle();
}

describe("serialPort field ordering and rescanning (#5066)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    lister.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("lists detected ports in natural order", async () => {
    lister.mockResolvedValue(["COM7", "COM27", "COM29", "COM28", "COM9", "COM10", "COM3"]);
    await render("");
    expect(optionValues()).toEqual(["COM3", "COM7", "COM9", "COM10", "COM27", "COM28", "COM29"]);
  });

  it("lists agent-supplied ports in natural order without scanning locally", async () => {
    await render("", vi.fn(), ["/dev/ttyUSB10", "/dev/ttyUSB2"]);
    await rescan();
    expect(lister).not.toHaveBeenCalled();
    expect(optionValues()).toEqual(["/dev/ttyUSB2", "/dev/ttyUSB10"]);
  });

  it("adds a newly plugged port while visible and announces it", async () => {
    lister.mockResolvedValueOnce(["COM3"]).mockResolvedValue(["COM3", "COM12"]);
    await render("");
    expect(optionValues()).toEqual(["COM3"]);
    expect(query("field-port-new")).toBeNull();

    await rescan();
    expect(optionValues()).toEqual(["COM3", "COM12"]);
    expect(query("field-port-new")?.textContent).toContain("COM12");
  });

  it("keeps the selection when its port is unplugged and marks it missing", async () => {
    const onChange = vi.fn();
    lister.mockResolvedValueOnce(["COM3", "COM5"]).mockResolvedValue(["COM3"]);
    await render("COM5", onChange);
    expect(query("field-port-disconnected")).toBeNull();

    await rescan();
    expect(optionValues()).toEqual(["COM3"]);
    expect((query("field-port") as HTMLInputElement).value).toBe("COM5");
    expect(onChange).not.toHaveBeenCalled();
    expect(query("field-port-disconnected")?.textContent).toContain("COM5");
  });

  it("does not flash the not-connected hint before the first scan returns", async () => {
    lister.mockReturnValue(new Promise<string[]>(() => {}));
    await render("COM5");
    expect(query("field-port-disconnected")).toBeNull();
  });

  it("stops rescanning once the field is unmounted", async () => {
    lister.mockResolvedValue(["COM3"]);
    await render("");
    const calls = lister.mock.calls.length;
    act(() => root.render(<div />));
    await rescan();
    await rescan();
    expect(lister.mock.calls.length).toBe(calls);
  });
});
