import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import type { AgentPendingUpdate } from "@/store/appStore";
import type { RemoteAgentDefinition } from "@/types/connection";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import * as api from "@/services/api";
import { AgentUpdateBanner, AgentUpdateMarker } from "./AgentUpdateBanner";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import * as expectedApplyDisconnect from "./expectedApplyDisconnect";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

// The expected-vs-real disconnect classification is unit-tested in
// expectedApplyDisconnect.test.ts (structured error code first, then the agents
// region's connectionState over a timed window). Here it is mocked to a boolean
// so most component tests assert the *wiring*: a true verdict → instructional
// success; a false verdict → the real failure is surfaced (rethrown), never
// swallowed. The #2840 cases below opt back into the real classifier.
vi.mock("./expectedApplyDisconnect", () => ({
  isExpectedApplyDisconnect: vi.fn(),
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

/** `n` session labels as the sidebar numbers them: bash, bash 2, … */
function names(n: number): string[] {
  return Array.from({ length: n }, (_, i) => (i === 0 ? "bash" : `bash ${i + 1}`));
}

async function render(openSessions?: number) {
  await act(async () => {
    root.render(
      <AgentUpdateBanner
        agentId={AGENT_ID}
        agentName={AGENT_NAME}
        sessionNames={openSessions === undefined ? undefined : names(openSessions)}
      />
    );
  });
}

/** The banner inside a sidebar at its narrowest width, beside the row marker. */
async function renderInNarrowSidebar() {
  await act(async () => {
    root.render(
      <div style={{ width: 200 }} data-testid="narrow-sidebar">
        <div data-testid="agent-row">
          <span>{AGENT_NAME}</span>
          <AgentUpdateMarker agentId={AGENT_ID} />
        </div>
        <AgentUpdateBanner agentId={AGENT_ID} agentName={AGENT_NAME} sessionNames={names(2)} />
      </div>
    );
  });
}

/** The declarations of one CSS rule, `{}` when the selector is missing. */
function cssRule(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(bannerCss);
  if (!match) return {};
  return Object.fromEntries(
    match[2]
      .split(";")
      .map((d) => d.split(":").map((part) => part.trim()))
      .filter(([k, v]) => k && v)
      .map(([k, v]) => [k, v])
  );
}

function byTestId(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${id}"]`);
}

const bannerCss = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "AgentUpdateBanner.css"),
  "utf8"
);

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
    mockedDisconnect.isExpectedApplyDisconnect.mockResolvedValue(false);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("renders when a staged update exists", async () => {
    await render();
    expect(byTestId(bannerId)).not.toBeNull();
    expect(byTestId(`agent-update-banner-title-${AGENT_ID}`)?.textContent).toBe(
      "Update to v0.2.0 available"
    );
    // The strip is a region named after its agent, not prose about it.
    expect(byTestId(bannerId)?.getAttribute("aria-label")).toBe(`Update for "${AGENT_NAME}"`);
  });

  it("labels the apply button with what it does", async () => {
    await render();
    expect(byTestId(applyId)?.textContent).toBe("Restart agent and update");
    expect(byTestId(dismissId)?.textContent).toBe("Close");
  });

  describe("narrow sidebar (#5821)", () => {
    it("puts only a marker on the row and the words in the strip", async () => {
      await renderInNarrowSidebar();
      const row = byTestId("agent-row");
      const marker = byTestId(`agent-update-marker-${AGENT_ID}`);
      expect(marker).not.toBeNull();
      expect(row?.contains(marker)).toBe(true);
      // No prose on the row: just the agent's name; the marker speaks via its label.
      expect(row?.textContent).toBe(AGENT_NAME);
      expect(marker?.getAttribute("aria-label")).toBe("Update to v0.2.0 available");
      // The strip is a sibling of the row, not inside it.
      const strip = byTestId(bannerId);
      expect(row?.contains(strip)).toBe(false);
      expect(strip?.parentElement).toBe(byTestId("narrow-sidebar"));
    });

    it("stacks the strip full width so its text never shares a line with the buttons", () => {
      const strip = cssRule(".agent-update-banner");
      expect(strip["flex-direction"]).toBe("column");
      expect(strip.width).toBe("100%");
      // The actions wrap on their own line rather than squeezing the text.
      expect(cssRule(".agent-update-banner__actions")["flex-wrap"]).toBe("wrap");
      expect(cssRule(".agent-update-banner__title")["overflow-wrap"]).toBe("anywhere");
    });

    it("keeps the strip's text short", async () => {
      await renderInNarrowSidebar();
      const title = byTestId(`agent-update-banner-title-${AGENT_ID}`)?.textContent ?? "";
      const note = byTestId(`agent-update-banner-note-${AGENT_ID}`)?.textContent ?? "";
      expect(title.split(" ").length).toBeLessThanOrEqual(4);
      expect(note).toBe("Waits for 2 sessions (bash, bash 2) to close.");
    });

    it("shows neither marker nor strip once closed", async () => {
      await renderInNarrowSidebar();
      await act(async () => {
        byTestId(dismissId)?.click();
      });
      expect(byTestId(`agent-update-marker-${AGENT_ID}`)).toBeNull();
      expect(byTestId(bannerId)).toBeNull();
    });
  });

  describe("confirm before apply (#5821)", () => {
    const confirmId = `agent-update-confirm-${AGENT_ID}`;

    it("applies at once, without asking, when no session is open", async () => {
      await render(0);
      expect(byTestId(`agent-update-banner-note-${AGENT_ID}`)?.textContent).toBe(
        "The agent restarts and reconnects."
      );
      await act(async () => {
        byTestId(applyId)?.click();
      });
      expect(byTestId(confirmId)).toBeNull();
      expect(mockedApi.requestAgentDeferredUpdate).toHaveBeenCalledWith(AGENT_ID);
    });

    it("asks first and names the open sessions", async () => {
      await render(2);
      await act(async () => {
        byTestId(applyId)?.click();
      });
      expect(mockedApi.requestAgentDeferredUpdate).not.toHaveBeenCalled();
      const dialog = byTestId(confirmId);
      expect(dialog).not.toBeNull();
      expect(dialog?.textContent).toContain(`Update "${AGENT_NAME}"?`);
      expect(dialog?.textContent).toContain("2 sessions (bash, bash 2) are open on this agent");
      expect(dialog?.textContent).toContain("not interrupted");
      await act(async () => {
        byTestId(`${confirmId}-confirm`)?.click();
      });
      expect(mockedApi.requestAgentDeferredUpdate).toHaveBeenCalledWith(AGENT_ID);
    });

    it("uses the singular for one session", async () => {
      await render(1);
      await act(async () => {
        byTestId(applyId)?.click();
      });
      expect(byTestId(confirmId)?.textContent).toContain("1 session (bash) is open on this agent");
    });

    it("does nothing when the confirm is canceled", async () => {
      await render(3);
      await act(async () => {
        byTestId(applyId)?.click();
      });
      await act(async () => {
        byTestId(`${confirmId}-cancel`)?.click();
      });
      expect(mockedApi.requestAgentDeferredUpdate).not.toHaveBeenCalled();
      expect(byTestId(confirmId)).toBeNull();
      expect(byTestId(bannerId)).not.toBeNull();
    });
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
    const dropped = new Error("Verbindung getrennt");
    mockedApi.requestAgentDeferredUpdate.mockRejectedValue(dropped);
    mockedDisconnect.isExpectedApplyDisconnect.mockResolvedValue(true);
    await render();
    await act(async () => {
      byTestId(applyId)?.click();
    });
    expect(mockedDisconnect.isExpectedApplyDisconnect).toHaveBeenCalledWith(AGENT_ID, dropped);
    expect(toastMocks.info).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().agentUpdatesDismissed[AGENT_ID]).toBe(true);
  });

  it("does NOT swallow a real update failure as success when the connection stays up", async () => {
    // The apply RPC rejects with a message that mentions "connection"/"closed" — the
    // old substring classifier would have misreported this as success. The connection
    // did not drop (verdict false), so it must be surfaced as a real failure: no
    // instructional toast, the staged update is not dismissed, the banner stays.
    const failure = new Error("update failed: connection to release server closed");
    mockedApi.requestAgentDeferredUpdate.mockRejectedValue(failure);
    mockedDisconnect.isExpectedApplyDisconnect.mockResolvedValue(false);
    await render();
    await act(async () => {
      byTestId(applyId)?.click();
    });
    expect(mockedDisconnect.isExpectedApplyDisconnect).toHaveBeenCalledWith(AGENT_ID, failure);
    expect(toastMocks.info).not.toHaveBeenCalled();
    expect(useAppStore.getState().agentUpdatesDismissed[AGENT_ID]).not.toBe(true);
    expect(byTestId(bannerId)).not.toBeNull();
  });

  describe("structured apply-error envelope (#2840, real classifier)", () => {
    beforeEach(async () => {
      const actual = await vi.importActual<typeof import("./expectedApplyDisconnect")>(
        "./expectedApplyDisconnect"
      );
      // Real classifier, with a short fallback window so the test stays fast.
      mockedDisconnect.isExpectedApplyDisconnect.mockImplementation((id, err) =>
        actual.isExpectedApplyDisconnect(id, err, 20)
      );
      // The agent's connection stays up throughout: only the structured code can
      // make the apply failure count as the expected swap disconnect.
      seedAgentsRegion({
        remoteAgents: [
          { id: AGENT_ID, name: AGENT_NAME, connectionState: "connected", config: {} },
        ] as unknown as RemoteAgentDefinition[],
      });
    });

    it("treats a structured transport-close as the expected swap disconnect", async () => {
      mockedApi.requestAgentDeferredUpdate.mockRejectedValue({
        code: "agent_transport_closed",
        message: "Remote agent error: Verbindung getrennt",
        details: null,
      });
      await render();
      await act(async () => {
        byTestId(applyId)?.click();
      });
      expect(toastMocks.info).toHaveBeenCalledTimes(1);
      expect(useAppStore.getState().agentUpdatesDismissed[AGENT_ID]).toBe(true);
    });

    it("surfaces a structured agent-reported application error as a real failure", async () => {
      mockedApi.requestAgentDeferredUpdate.mockRejectedValue({
        code: "remote_error",
        message: "Remote agent error: update refused, connection closed by policy",
        details: null,
      });
      await render();
      await act(async () => {
        byTestId(applyId)?.click();
        // Let the (shortened) connection-state fallback window elapse.
        await new Promise((r) => setTimeout(r, 60));
      });
      expect(toastMocks.info).not.toHaveBeenCalled();
      expect(useAppStore.getState().agentUpdatesDismissed[AGENT_ID]).not.toBe(true);
      expect(byTestId(bannerId)).not.toBeNull();
    });
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
