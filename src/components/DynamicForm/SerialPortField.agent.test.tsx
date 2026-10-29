import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { listAgentSerialPorts, listSerialPorts } from "@/services/api";
import type { SettingsField } from "@/types/schema";
import { DynamicField } from "./DynamicField";
import { SERIAL_PORT_RESCAN_INTERVAL_MS } from "./useSerialPortRescan";

vi.mock("@/services/api", () => ({ listSerialPorts: vi.fn(), listAgentSerialPorts: vi.fn() }));

const localLister = listSerialPorts as ReturnType<typeof vi.fn>;
const agentLister = listAgentSerialPorts as ReturnType<typeof vi.fn>;

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

/** Render the field as the connection editor does for an agent-hosted serial connection. */
async function render(
  value: string,
  snapshot: string[] | undefined,
  agentId: string | undefined,
  onChange: (v: unknown) => void = vi.fn()
): Promise<void> {
  act(() => {
    root.render(
      <DynamicField
        field={serialPortField}
        value={value}
        onChange={onChange}
        availablePorts={snapshot}
        serialPortAgentId={agentId}
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

const ok = (ports: string[]) => ({ supported: true, ports });

describe("serialPort field of an agent-hosted connection (#5069)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localLister.mockReset();
    agentLister.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("polls the agent's ports while visible, never the local ones", async () => {
    agentLister
      .mockResolvedValueOnce(ok(["/dev/ttyUSB0"]))
      .mockResolvedValue(ok(["/dev/ttyUSB0", "/dev/ttyUSB1"]));
    await render("", ["/dev/ttyUSB0"], "agent-1");
    expect(agentLister).toHaveBeenCalledWith("agent-1");
    expect(optionValues()).toEqual(["/dev/ttyUSB0"]);

    await rescan();
    expect(optionValues()).toEqual(["/dev/ttyUSB0", "/dev/ttyUSB1"]);
    expect(query("field-port-new")?.textContent).toContain("/dev/ttyUSB1");
    expect(localLister).not.toHaveBeenCalled();
  });

  it("shows the connect-time snapshot until the first agent scan returns", async () => {
    agentLister.mockReturnValue(new Promise(() => {}));
    await render("/dev/ttyUSB0", ["/dev/ttyUSB10", "/dev/ttyUSB0"], "agent-1");
    expect(optionValues()).toEqual(["/dev/ttyUSB0", "/dev/ttyUSB10"]);
    expect(query("field-port-disconnected")).toBeNull();
  });

  it("keeps the selection when the agent's port is unplugged and marks it", async () => {
    const onChange = vi.fn();
    agentLister
      .mockResolvedValueOnce(ok(["/dev/ttyUSB0", "/dev/ttyUSB1"]))
      .mockResolvedValue(ok(["/dev/ttyUSB0"]));
    await render("/dev/ttyUSB1", ["/dev/ttyUSB0", "/dev/ttyUSB1"], "agent-1", onChange);
    expect(query("field-port-disconnected")).toBeNull();

    await rescan();
    expect(optionValues()).toEqual(["/dev/ttyUSB0"]);
    expect((query("field-port") as HTMLInputElement).value).toBe("/dev/ttyUSB1");
    expect(onChange).not.toHaveBeenCalled();
    expect(query("field-port-disconnected")?.textContent).toContain("/dev/ttyUSB1");
  });

  it("falls back to the snapshot and stops polling when the agent lacks the method", async () => {
    agentLister.mockResolvedValue({ supported: false, ports: [] });
    await render("", ["/dev/ttyS0"], "agent-1");
    expect(optionValues()).toEqual(["/dev/ttyS0"]);
    await rescan();
    await rescan();
    expect(agentLister).toHaveBeenCalledTimes(1);
    expect(optionValues()).toEqual(["/dev/ttyS0"]);
  });

  it("keeps the last list and backs off while the agent request fails", async () => {
    agentLister
      .mockResolvedValueOnce(ok(["/dev/ttyUSB0", "/dev/ttyUSB1"]))
      .mockRejectedValue(new Error("Agent request timed out"));
    await render("", ["/dev/ttyUSB0"], "agent-1");
    for (let i = 0; i < 8; i++) await rescan();
    expect(optionValues()).toEqual(["/dev/ttyUSB0", "/dev/ttyUSB1"]);
    // 1 + failures at 1×, 2×, 4× the interval within 8 intervals — not 9 calls.
    expect(agentLister.mock.calls.length).toBeLessThan(5);
  });

  it("uses only the snapshot for an agent without the rescan capability", async () => {
    await render("", ["/dev/ttyUSB2", "/dev/ttyUSB10"], undefined);
    await rescan();
    expect(agentLister).not.toHaveBeenCalled();
    expect(localLister).not.toHaveBeenCalled();
    expect(optionValues()).toEqual(["/dev/ttyUSB2", "/dev/ttyUSB10"]);
  });

  it("never scans the local machine for an agent-hosted field, even after unsupported", async () => {
    agentLister.mockResolvedValue({ supported: false, ports: [] });
    await render("", undefined, "agent-1");
    await rescan();
    await rescan();
    expect(localLister).not.toHaveBeenCalled();
    expect(optionValues()).toEqual([]);
  });
});
