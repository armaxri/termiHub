import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { UpdateAgentDialog } from "./UpdateAgentDialog";
import type { ConnectedHost } from "@/services/api";
import type { RemoteAgentConfig } from "@/types/terminal";
import * as api from "@/services/api";

vi.mock("@/services/api", async () => {
  const actual = await vi.importActual<typeof import("@/services/api")>("@/services/api");
  return {
    ...actual,
    updateAgent: vi.fn(),
    updateAgentForce: vi.fn(),
  };
});

const mockedUpdateAgent = vi.mocked(api.updateAgent);
const mockedUpdateAgentForce = vi.mocked(api.updateAgentForce);

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

const CONFIG = { host: "prod-server-1" } as unknown as RemoteAgentConfig;

const HOSTS: ConnectedHost[] = [
  {
    clientId: "id-1",
    client: "staging-pc",
    clientVersion: "0.2.1",
    connectedSince: new Date(Date.now() - 43 * 60_000).toISOString(),
  },
  {
    clientId: "id-2",
    client: "macbook-anne",
    clientVersion: "0.2.1",
    connectedSince: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  },
];

function baseProps() {
  return {
    open: true,
    onOpenChange: vi.fn(),
    agentId: "agent-1",
    agentName: "prod-server-1",
    config: CONFIG,
    installedVersion: "0.2.1",
    availableVersion: "0.3.0",
    otherHosts: [] as ConnectedHost[],
  };
}

describe("UpdateAgentDialog", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockedUpdateAgent.mockResolvedValue({
      kind: "deployed",
      success: true,
      installedVersion: "0.3.0",
    });
    mockedUpdateAgentForce.mockResolvedValue({
      kind: "deployed",
      success: true,
      installedVersion: "0.3.0",
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("renders installed and available versions", () => {
    render(<UpdateAgentDialog {...baseProps()} />);
    const dialog = document.querySelector('[data-testid="update-agent-dialog"]');
    expect(dialog?.textContent).toContain("0.2.1");
    expect(dialog?.textContent).toContain("0.3.0");
  });

  it("omits the other-hosts warning and offers a plain Update when no other hosts", () => {
    render(<UpdateAgentDialog {...baseProps()} otherHosts={[]} />);
    expect(document.querySelector('[data-testid="update-agent-other-hosts"]')).toBeNull();
    const confirm = document.querySelector('[data-testid="update-agent-confirm"]');
    expect(confirm?.textContent).toContain("Update");
    expect(confirm?.textContent).not.toContain("Notify");
  });

  it("renders the other-hosts warning listing connected hosts when non-empty", () => {
    render(<UpdateAgentDialog {...baseProps()} otherHosts={HOSTS} />);
    const warning = document.querySelector('[data-testid="update-agent-other-hosts"]');
    expect(warning).not.toBeNull();
    expect(warning?.textContent).toContain("staging-pc");
    expect(warning?.textContent).toContain("macbook-anne");
    const confirm = document.querySelector('[data-testid="update-agent-confirm"]');
    expect(confirm?.textContent).toContain("Notify Others & Update");
  });

  it("calls updateAgent (not force) when there are no other hosts", async () => {
    render(<UpdateAgentDialog {...baseProps()} otherHosts={[]} />);
    await act(async () => {
      (document.querySelector('[data-testid="update-agent-confirm"]') as HTMLElement).click();
    });
    expect(mockedUpdateAgent).toHaveBeenCalledTimes(1);
    expect(mockedUpdateAgent).toHaveBeenCalledWith("agent-1", CONFIG, {});
    expect(mockedUpdateAgentForce).not.toHaveBeenCalled();
  });

  it("calls updateAgentForce when other hosts are connected", async () => {
    render(<UpdateAgentDialog {...baseProps()} otherHosts={HOSTS} />);
    await act(async () => {
      (document.querySelector('[data-testid="update-agent-confirm"]') as HTMLElement).click();
    });
    expect(mockedUpdateAgentForce).toHaveBeenCalledTimes(1);
    expect(mockedUpdateAgentForce).toHaveBeenCalledWith("agent-1", CONFIG, {});
    expect(mockedUpdateAgent).not.toHaveBeenCalled();
  });

  it("closes after a successful update", async () => {
    const props = baseProps();
    render(<UpdateAgentDialog {...props} otherHosts={[]} />);
    await act(async () => {
      (document.querySelector('[data-testid="update-agent-confirm"]') as HTMLElement).click();
    });
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("cancel closes the dialog without updating", () => {
    const props = baseProps();
    render(<UpdateAgentDialog {...props} />);
    act(() => {
      (document.querySelector('[data-testid="update-agent-cancel"]') as HTMLElement).click();
    });
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
    expect(mockedUpdateAgent).not.toHaveBeenCalled();
  });

  it("closes and reports a coordinated (Unix) update result (#1616)", async () => {
    // A coordinated-strategy agent returns `kind: "coordinated"` rather than
    // `deployed`; the dialog must treat it as success and close.
    mockedUpdateAgent.mockResolvedValue({
      kind: "coordinated",
      applied: true,
      activeSessions: 0,
      notifiedClients: 2,
      allAcked: true,
      remainingClients: [],
    });
    const props = baseProps();
    const onUpdated = vi.fn();
    render(<UpdateAgentDialog {...props} otherHosts={[]} onUpdated={onUpdated} />);
    await act(async () => {
      (document.querySelector('[data-testid="update-agent-confirm"]') as HTMLElement).click();
    });
    expect(mockedUpdateAgent).toHaveBeenCalledTimes(1);
    expect(onUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "coordinated", notifiedClients: 2 })
    );
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps the dialog open when a deferred coordinated update reports active sessions", async () => {
    mockedUpdateAgent.mockResolvedValue({
      kind: "coordinated",
      applied: false,
      activeSessions: 3,
      notifiedClients: 1,
      allAcked: false,
      remainingClients: ["id-2"],
    });
    const props = baseProps();
    const onUpdated = vi.fn();
    render(<UpdateAgentDialog {...props} otherHosts={[]} onUpdated={onUpdated} />);
    await act(async () => {
      (document.querySelector('[data-testid="update-agent-confirm"]') as HTMLElement).click();
    });
    // Deferred is still a successful dispatch — the dialog closes and reports it.
    expect(onUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "coordinated", applied: false, activeSessions: 3 })
    );
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });
});
