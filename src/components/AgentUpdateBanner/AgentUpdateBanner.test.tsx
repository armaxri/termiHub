import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import type { AgentPendingUpdate } from "@/store/appStore";
import type { RemoteAgentDefinition } from "@/types/connection";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import * as api from "@/services/api";
import { AgentUpdateBanner } from "./AgentUpdateBanner";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/api")>();
  return {
    ...actual,
    requestAgentDeferredUpdate: vi.fn(),
    requestAgentUpdate: vi.fn(),
  };
});

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return {
    ...actual,
    toast: toastMocks,
  };
});

const mockedApi = vi.mocked(api);

const AGENT_ID = "agent-1";
const AGENT_NAME = "prod-box";

function stagedUpdate(overrides: Partial<AgentPendingUpdate> = {}): AgentPendingUpdate {
  return { currentVersion: "0.1.0", availableVersion: "0.2.0", staged: true, ...overrides };
}

let container: HTMLDivElement;
let root: Root;

async function render() {
  await act(async () => {
    root.render(<AgentUpdateBanner agentId={AGENT_ID} agentName={AGENT_NAME} />);
  });
}

function byTestId(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${id}"]`);
}

const bannerId = `agent-update-banner-${AGENT_ID}`;
const applyId = `agent-update-banner-apply-${AGENT_ID}`;
const dismissId = `agent-update-banner-dismiss-${AGENT_ID}`;

setupAgentsRegion();

describe("AgentUpdateBanner", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    useAppStore.setState({
      agentUpdates: { [AGENT_ID]: stagedUpdate() },
      agentUpdatesDismissed: {},
    });
    mockedApi.requestAgentDeferredUpdate.mockResolvedValue({ applied: true, activeSessions: 0 });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("renders when a staged update exists", async () => {
    await render();
    expect(byTestId(bannerId)).not.toBeNull();
    expect(byTestId(bannerId)?.textContent).toContain("0.2.0");
    expect(byTestId(bannerId)?.textContent).toContain(AGENT_NAME);
  });

  it("does not render when no update is recorded", async () => {
    useAppStore.setState({ agentUpdates: {} });
    await render();
    expect(byTestId(bannerId)).toBeNull();
  });

  it("does not render when the update is not staged", async () => {
    useAppStore.setState({ agentUpdates: { [AGENT_ID]: stagedUpdate({ staged: false }) } });
    await render();
    expect(byTestId(bannerId)).toBeNull();
  });

  it("applies immediately and shows success when applied=true", async () => {
    await render();
    await act(async () => {
      byTestId(applyId)?.click();
    });
    expect(mockedApi.requestAgentDeferredUpdate).toHaveBeenCalledWith(AGENT_ID);
    expect(toastMocks.success).toHaveBeenCalledTimes(1);
    // Banner hides once the update has been triggered.
    expect(byTestId(bannerId)).toBeNull();
  });

  it("shows the deferred message when applied=false", async () => {
    mockedApi.requestAgentDeferredUpdate.mockResolvedValue({ applied: false, activeSessions: 3 });
    await render();
    await act(async () => {
      byTestId(applyId)?.click();
    });
    expect(toastMocks.info).toHaveBeenCalledTimes(1);
    expect(toastMocks.info.mock.calls[0][0]).toContain("3");
    expect(toastMocks.success).not.toHaveBeenCalled();
  });

  it("treats a post-apply connection drop as instructional, not an error", async () => {
    mockedApi.requestAgentDeferredUpdate.mockRejectedValue(new Error("connection closed"));
    await render();
    await act(async () => {
      byTestId(applyId)?.click();
    });
    expect(toastMocks.info).toHaveBeenCalledTimes(1);
    expect(toastMocks.error).not.toHaveBeenCalled();
  });

  it("hides the banner on Dismiss without calling the update API", async () => {
    await render();
    await act(async () => {
      byTestId(dismissId)?.click();
    });
    expect(byTestId(bannerId)).toBeNull();
    expect(mockedApi.requestAgentDeferredUpdate).not.toHaveBeenCalled();
    expect(useAppStore.getState().agentUpdatesDismissed[AGENT_ID]).toBe(true);
  });

  describe("coordinated strategy (#1602)", () => {
    function seedCoordinatedAgent(): void {
      seedAgentsRegion({
        remoteAgents: [
          {
            id: AGENT_ID,
            name: AGENT_NAME,
            config: { updateStrategy: "coordinated" },
          },
        ] as unknown as RemoteAgentDefinition[],
      });
    }

    it("routes Apply Now through agent.request_update, not the deferred RPC", async () => {
      seedCoordinatedAgent();
      mockedApi.requestAgentUpdate.mockResolvedValue({
        applied: true,
        activeSessions: 0,
        notifiedClients: 2,
        allAcked: true,
        remainingClients: [],
      });
      await render();
      await act(async () => {
        byTestId(applyId)?.click();
      });
      expect(mockedApi.requestAgentUpdate).toHaveBeenCalledWith(AGENT_ID);
      expect(mockedApi.requestAgentDeferredUpdate).not.toHaveBeenCalled();
      // The success notice mentions the hosts that were warned.
      expect(toastMocks.success).toHaveBeenCalledTimes(1);
      expect(toastMocks.success.mock.calls[0][0]).toContain("2");
    });

    it("shows the deferred message when the coordinated apply is deferred", async () => {
      seedCoordinatedAgent();
      mockedApi.requestAgentUpdate.mockResolvedValue({
        applied: false,
        activeSessions: 4,
        notifiedClients: 1,
        allAcked: true,
        remainingClients: [],
      });
      await render();
      await act(async () => {
        byTestId(applyId)?.click();
      });
      expect(toastMocks.info).toHaveBeenCalledTimes(1);
      expect(toastMocks.info.mock.calls[0][0]).toContain("4");
      expect(toastMocks.success).not.toHaveBeenCalled();
    });
  });
});
