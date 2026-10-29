/**
 * "New Serial Session" in a connected agent's context menu (#5075): an agent
 * advertising `serialPortRescan` is asked for its current ports while the menu
 * is open (rescanned with the editor's backoff), so an adapter plugged in after
 * connect is offered and an unplugged one is not. Older agents keep the
 * connect-time `availableSerialPorts` snapshot.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { AgentNode } from "./AgentNode";
import { DEFAULT_AGENT_SETTINGS, type RemoteAgentDefinition } from "@/types/connection";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import type { AgentSerialPortsResult } from "@/services/api";
import { SERIAL_PORT_RESCAN_INTERVAL_MS } from "@/components/DynamicForm/useSerialPortRescan";

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));

vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: vi.fn(), isDragging: false }),
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
  useDndContext: () => ({ active: null }),
  useDndMonitor: () => {},
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => "" } },
}));

const listAgentSerialPortsMock = vi.fn(
  (..._args: unknown[]): Promise<AgentSerialPortsResult> =>
    Promise.resolve({ supported: true, ports: [] })
);

vi.mock("@/services/api", () => ({
  removeCredential: vi.fn(() => Promise.resolve()),
  storeCredential: vi.fn(() => Promise.resolve()),
  cancelConnectAgent: vi.fn(() => Promise.resolve()),
  disconnectAgent: vi.fn(() => Promise.resolve()),
  shutdownAgent: vi.fn(() => Promise.resolve(0)),
  listAgentConnections: vi.fn(() => Promise.resolve({ connections: [], folders: [] })),
  saveAgentDefinition: vi.fn(),
  updateAgentDefinition: vi.fn(),
  deleteAgentDefinition: vi.fn(() => Promise.resolve()),
  createAgentFolder: vi.fn(),
  updateAgentFolder: vi.fn(),
  deleteAgentFolder: vi.fn(() => Promise.resolve()),
  listSerialPorts: vi.fn(() => Promise.resolve(["/dev/local-should-not-be-used"])),
  listAgentSerialPorts: (...args: unknown[]) => listAgentSerialPortsMock(...args),
}));

vi.mock("@/hooks/useDesktopVersion", () => ({ useDesktopVersion: () => "0.5.0" }));
vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return {
    ...actual,
    Tooltip: ({ children }: { children: React.ReactNode }) => children,
  };
});
vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn(), frontendError: vi.fn() }));
vi.mock("./AgentSetupDialog", () => ({ AgentSetupDialog: () => null }));
vi.mock("./ConnectionErrorDialog", () => ({ ConnectionErrorDialog: () => null }));
vi.mock("./InlineFolderInput", () => ({ InlineFolderInput: () => null }));
vi.mock("@/components/AgentUpdateBanner", () => ({ AgentUpdateBanner: () => null }));

const AGENT_ID = "agent-serial-menu-test";

function makeAgent(snapshot: string[], serialPortRescan?: boolean): RemoteAgentDefinition {
  return {
    id: AGENT_ID,
    name: "Lab Box",
    config: { host: "lab.example.com", port: 22, username: "user", authMethod: "password" },
    connectionState: "connected",
    isExpanded: true,
    agentSettings: DEFAULT_AGENT_SETTINGS,
    capabilities: {
      connectionTypes: [],
      maxSessions: 10,
      availableShells: ["bash"],
      availableSerialPorts: snapshot,
      availableDockerImages: [],
      agentVersion: "0.5.0",
      ...(serialPortRescan === undefined ? {} : { serialPortRescan }),
    },
  };
}

let container: HTMLDivElement;
let root: Root;
let addTab: ReturnType<typeof vi.fn<(...args: unknown[]) => string>>;

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const serialItem = () =>
  document.querySelector<HTMLElement>('[data-testid="context-agent-new-serial"]');

setupAgentsRegion();

describe("AgentNode — New Serial Session port list (#5075)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    addTab = vi.fn((..._args: unknown[]) => "tab-id");
    useAppStore.setState({ addTab });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
    listAgentSerialPortsMock.mockReset();
    listAgentSerialPortsMock.mockResolvedValue({ supported: true, ports: [] });
  });

  function render(agent: RemoteAgentDefinition): void {
    seedAgentsRegion({ remoteAgents: [agent] });
    act(() => {
      root.render(React.createElement(AgentNode, { agent }));
    });
  }

  async function openMenu(): Promise<void> {
    const header = container.querySelector(`[data-testid="agent-header-${AGENT_ID}"]`);
    expect(header).not.toBeNull();
    act(() => {
      header!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    });
    await flush();
  }

  async function chooseSerial(): Promise<void> {
    const item = serialItem();
    expect(item).not.toBeNull();
    act(() => item!.click());
    await flush();
  }

  it("offers a port plugged in after connect, from a fresh agent scan", async () => {
    listAgentSerialPortsMock.mockResolvedValue({ supported: true, ports: ["/dev/ttyUSB0"] });
    render(makeAgent([], true));
    await openMenu();

    expect(listAgentSerialPortsMock).toHaveBeenCalledWith(AGENT_ID);
    await chooseSerial();
    expect(addTab).toHaveBeenCalledWith(
      "Serial: /dev/ttyUSB0",
      "remote-session",
      expect.objectContaining({
        config: expect.objectContaining({ agentId: AGENT_ID, serialPort: "/dev/ttyUSB0" }),
      })
    );
  });

  it("does not scan the agent while the menu is closed", async () => {
    render(makeAgent(["/dev/ttyUSB0"], true));
    await flush();
    expect(listAgentSerialPortsMock).not.toHaveBeenCalled();
  });

  it("drops an unplugged snapshot port and defaults to the first port in natural order", async () => {
    listAgentSerialPortsMock.mockResolvedValue({
      supported: true,
      ports: ["/dev/ttyUSB10", "/dev/ttyUSB2"],
    });
    render(makeAgent(["/dev/ttyACM0"], true));
    await openMenu();
    await chooseSerial();
    expect(addTab).toHaveBeenCalledWith(
      "Serial: /dev/ttyUSB2",
      "remote-session",
      expect.objectContaining({
        config: expect.objectContaining({ serialPort: "/dev/ttyUSB2" }),
      })
    );
  });

  it("hides the item when the fresh scan finds no ports, despite a snapshot", async () => {
    listAgentSerialPortsMock.mockResolvedValue({ supported: true, ports: [] });
    render(makeAgent(["/dev/ttyACM0"], true));
    await openMenu();
    expect(document.querySelector('[data-testid="context-agent-new-shell"]')).not.toBeNull();
    expect(serialItem()).toBeNull();
  });

  it("rescans while the menu stays open, so a newly plugged port appears", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    listAgentSerialPortsMock.mockResolvedValueOnce({ supported: true, ports: [] });
    listAgentSerialPortsMock.mockResolvedValue({ supported: true, ports: ["COM3"] });
    render(makeAgent([], true));
    await openMenu();
    expect(serialItem()).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(SERIAL_PORT_RESCAN_INTERVAL_MS);
    });
    await flush();
    expect(listAgentSerialPortsMock).toHaveBeenCalledTimes(2);
    expect(serialItem()).not.toBeNull();
  });

  it("keeps the snapshot while a scan fails", async () => {
    listAgentSerialPortsMock.mockRejectedValue(new Error("agent did not answer"));
    render(makeAgent(["/dev/ttyACM0"], true));
    await openMenu();
    await chooseSerial();
    expect(addTab).toHaveBeenCalledWith(
      "Serial: /dev/ttyACM0",
      "remote-session",
      expect.objectContaining({ config: expect.objectContaining({ serialPort: "/dev/ttyACM0" }) })
    );
  });

  it("keeps the snapshot when the agent reports rescan as unsupported", async () => {
    listAgentSerialPortsMock.mockResolvedValue({ supported: false, ports: [] });
    render(makeAgent(["/dev/ttyACM0"], true));
    await openMenu();
    await chooseSerial();
    expect(addTab).toHaveBeenCalledWith(
      "Serial: /dev/ttyACM0",
      "remote-session",
      expect.objectContaining({ config: expect.objectContaining({ serialPort: "/dev/ttyACM0" }) })
    );
  });

  describe("older agent without serialPortRescan", () => {
    it("uses the connect-time snapshot and never asks the agent", async () => {
      render(makeAgent(["/dev/ttyS1", "/dev/ttyS0"]));
      await openMenu();
      await chooseSerial();
      expect(listAgentSerialPortsMock).not.toHaveBeenCalled();
      expect(addTab).toHaveBeenCalledWith(
        "Serial: /dev/ttyS1",
        "remote-session",
        expect.objectContaining({ config: expect.objectContaining({ serialPort: "/dev/ttyS1" }) })
      );
    });

    it("hides the item when the snapshot is empty", async () => {
      render(makeAgent([], false));
      await openMenu();
      expect(document.querySelector('[data-testid="context-agent-new-shell"]')).not.toBeNull();
      expect(serialItem()).toBeNull();
      expect(listAgentSerialPortsMock).not.toHaveBeenCalled();
    });
  });
});
