import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { filterSessionBySelection, resolveRestoreMode, summarizeLastSession } from "./restoreMode";
import type { AppSettings, SavedConnection } from "@/types/connection";
import type { LastSession } from "@/types/lastSession";

// The restore-mode decision logic now lives in `core::restore_mode` (Rust) and
// is reached over IPC (#2200). These wrappers are thin delegations; the pure
// behaviour (label derivation, target derivation, session pruning, legacy-mode
// migration) is proven equivalent to the retired TypeScript logic by the golden
// vectors in `core/tests/restore_mode_golden.rs`, extracted from this suite's
// original cases. Here we only assert the frontend delegates correctly: the
// right command, the right argument shape, and the command's result returned
// verbatim.

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockInvoke = vi.mocked(invoke);

function settings(partial: Partial<AppSettings>): AppSettings {
  return { version: "1", externalConnectionFiles: [], ...partial } as AppSettings;
}

beforeEach(() => {
  mockInvoke.mockReset();
});

describe("resolveRestoreMode", () => {
  it("delegates to restore_resolve_mode and returns its result", async () => {
    mockInvoke.mockResolvedValueOnce("always");
    const s = settings({ restoreLastSessionMode: "always" });
    await expect(resolveRestoreMode(s)).resolves.toBe("always");
    expect(mockInvoke).toHaveBeenCalledWith("restore_resolve_mode", { settings: s });
  });
});

describe("summarizeLastSession", () => {
  const session: LastSession = {
    version: "1",
    activeGroupIndex: 0,
    tabGroups: [
      {
        name: "Group",
        layout: {
          type: "leaf",
          tabs: [{ title: "prod-db", inlineConfig: { type: "ssh", config: { host: "prod-db" } } }],
        },
      },
    ],
  };

  it("delegates to restore_summarize_last_session with session and connections", async () => {
    const prompt = { tabCount: 1, tabs: [{ title: "prod-db", typeLabel: "SSH" }] };
    mockInvoke.mockResolvedValueOnce(prompt);
    const connections: SavedConnection[] = [];
    await expect(summarizeLastSession(session, connections)).resolves.toBe(prompt);
    expect(mockInvoke).toHaveBeenCalledWith("restore_summarize_last_session", {
      session,
      connections,
    });
  });

  it("defaults connections to an empty array when omitted", async () => {
    mockInvoke.mockResolvedValueOnce({ tabCount: 0, tabs: [] });
    await summarizeLastSession(session);
    expect(mockInvoke).toHaveBeenCalledWith("restore_summarize_last_session", {
      session,
      connections: [],
    });
  });
});

describe("filterSessionBySelection", () => {
  const session: LastSession = {
    version: "1",
    activeGroupIndex: 0,
    tabGroups: [
      { name: "Group", layout: { type: "leaf", tabs: [{ title: "a" }, { title: "b" }] } },
    ],
  };

  it("delegates to restore_filter_session_by_selection with the selection as an array", async () => {
    mockInvoke.mockResolvedValueOnce(session);
    await expect(filterSessionBySelection(session, new Set([0, 2]))).resolves.toBe(session);
    expect(mockInvoke).toHaveBeenCalledWith("restore_filter_session_by_selection", {
      session,
      selected: [0, 2],
    });
  });
});
