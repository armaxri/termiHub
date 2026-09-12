import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import type { AgentPendingUpdate } from "@/store/appStore";
import type { RemoteAgentDefinition } from "@/types/connection";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import * as api from "@/services/api";
import { AgentUpdateBanner } from "./AgentUpdateBanner";
import * as expectedApplyDisconnect from "./expectedApplyDisconnect";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

// The expected-vs-real disconnect classification is unit-tested in
// expectedApplyDisconnect.test.ts (it reads the agents region's connectionState
// over a timed window). Here we mock it to a synchronous boolean so the component
// tests assert the *wiring*: a true verdict → instructional success; a false
// verdict → the real failure is surfaced (rethrown), never swallowed.
vi.mock("./expectedApplyDisconnect", () => ({
  awaitExpectedApplyDisconnect: vi.fn(),
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
const mockedDisconnect = vi.mocked(expectedApplyDisconnect);

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
    // Default: no transport drop observed (real-failure verdict) unless a test opts in.
    mockedDisconnect.awaitExpectedApplyDisconnect.mockResolvedValue(false);
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

  it("treats a post-apply transport drop (flow-state verdict) as instructional, not an error", async () => {
    // The apply RPC rejects because the transport died as the agent re-execs; the
    // classifier confirms the agent's connection dropped → expected success. The
    // rejection message is deliberately non-English to prove the decision does not
    // depend on message text (I18N-008).
    mockedApi.requestAgentDeferredUpdate.mockRejectedValue(new Error("Verbindung getrennt"));
    mockedDisconnect.awaitExpectedApplyDisconnect.mockResolvedValue(true);
    await render();
    await act(async () => {
      byTestId(applyId)?.click();
    });
    expect(mockedDisconnect.awaitExpectedApplyDisconnect).toHaveBeenCalledWith(AGENT_ID);
    expect(toastMocks.info).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().agentUpdatesDismissed[AGENT_ID]).toBe(true);
  });

  it("does NOT swallow a real update failure as success when the connection stays up", async () => {
    // The apply RPC rejects with a message that mentions "connection"/"closed" — the
    // old substring classifier would have misreported this as success. The connection
    // did not drop (verdict false), so it must be surfaced as a real failure: no
    // instructional toast, the staged update is not dismissed, the banner stays.
    mockedApi.requestAgentDeferredUpdate.mockRejectedValue(
      new Error("update failed: connection to release server closed")
    );
    mockedDisconnect.awaitExpectedApplyDisconnect.mockResolvedValue(false);
    await render();
    await act(async () => {
      byTestId(applyId)?.click();
    });
    expect(mockedDisconnect.awaitExpectedApplyDisconnect).toHaveBeenCalledWith(AGENT_ID);
    expect(toastMocks.info).not.toHaveBeenCalled();
    expect(useAppStore.getState().agentUpdatesDismissed[AGENT_ID]).not.toBe(true);
    expect(byTestId(bannerId)).not.toBeNull();
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
