import { describe, it, expect, vi, beforeEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useAgentSetupStatus } from "@/store/agentSetupStatus";
import { useAgentSetupProgressEvents } from "./useAgentSetupProgressEvents";

type ProgressCallback = (agentId: string, step: string, message: string) => void;
let progressCallback: ProgressCallback | null = null;

vi.mock("@/services/events", () => ({
  onAgentSetupProgress: vi.fn(async (cb: ProgressCallback) => {
    progressCallback = cb;
    return vi.fn();
  }),
}));

function Probe(): null {
  useAgentSetupProgressEvents();
  return null;
}

describe("useAgentSetupProgressEvents (#5906)", () => {
  beforeEach(() => {
    progressCallback = null;
    useAgentSetupStatus.setState({ phases: {} });
  });

  it("folds every agent's setup progress into its phase, app-wide", async () => {
    const root = createRoot(document.createElement("div"));
    await act(async () => {
      root.render(<Probe />);
      await Promise.resolve();
    });
    act(() => progressCallback?.("a", "upload", "Uploading…"));
    expect(useAgentSetupStatus.getState().phases).toEqual({ a: "installing" });
    act(() => progressCallback?.("a", "done", "Agent installed"));
    expect(useAgentSetupStatus.getState().phases).toEqual({ a: "installed" });
    act(() => root.unmount());
  });
});
