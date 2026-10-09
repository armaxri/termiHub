/**
 * Tests for launching a workspace named on the command line — both at startup
 * and when a second launch forwards `--workspace` / `--workspace-file` to the
 * already-running instance (#3101).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { launchWorkspaceByName, CLI_WORKSPACE_REQUESTED_EVENT } from "./cliWorkspace";
import { useAppStore } from "@/store/appStore";

type Workspaces = ReturnType<typeof useAppStore.getState>["workspaces"];

function seedWorkspaces(names: string[]): void {
  useAppStore.setState({
    workspaces: names.map((name, i) => ({ id: `ws-${i}`, name })) as unknown as Workspaces,
  });
}

describe("launchWorkspaceByName", () => {
  const initialState = useAppStore.getState();

  afterEach(() => {
    vi.restoreAllMocks();
    // Seeding replaces the state object, carrying the spies along; restore the
    // pristine state so no spied action leaks into another test.
    useAppStore.setState(initialState, true);
  });

  it("matches the name case-insensitively and launches it", async () => {
    seedWorkspaces(["Other", "Dev Box"]);
    const launch = vi.spyOn(useAppStore.getState(), "launchWorkspace").mockResolvedValue();

    const launched = await launchWorkspaceByName("dev box");

    expect(launched).toBe(true);
    expect(launch).toHaveBeenCalledWith("ws-1");
  });

  it("routes a forwarded launch through the confirm-first entry point (UX2-002)", async () => {
    seedWorkspaces(["Dev Box"]);
    const launch = vi.spyOn(useAppStore.getState(), "launchWorkspace").mockResolvedValue();
    const request = vi
      .spyOn(useAppStore.getState(), "requestLaunchWorkspace")
      .mockImplementation(() => {});

    const launched = await launchWorkspaceByName("Dev Box", { confirmIfLive: true });

    expect(launched).toBe(true);
    expect(request).toHaveBeenCalledWith("ws-0");
    expect(launch).not.toHaveBeenCalled();
  });

  it("returns false without launching when no workspace matches", async () => {
    seedWorkspaces(["Other"]);
    const launch = vi.spyOn(useAppStore.getState(), "launchWorkspace").mockResolvedValue();

    const launched = await launchWorkspaceByName("Missing");

    expect(launched).toBe(false);
    expect(launch).not.toHaveBeenCalled();
  });

  it("reloads workspaces first when asked, so a forwarded --workspace-file is found", async () => {
    seedWorkspaces([]);
    const reload = vi.spyOn(useAppStore.getState(), "loadWorkspaces").mockImplementation(() => {
      seedWorkspaces(["Imported"]);
      return Promise.resolve();
    });
    const launch = vi.spyOn(useAppStore.getState(), "launchWorkspace").mockResolvedValue();

    const launched = await launchWorkspaceByName("Imported", { reload: true });

    expect(reload).toHaveBeenCalledTimes(1);
    expect(launched).toBe(true);
    expect(launch).toHaveBeenCalledWith("ws-0");
  });

  it("does not reload by default", async () => {
    seedWorkspaces(["Dev"]);
    const reload = vi.spyOn(useAppStore.getState(), "loadWorkspaces").mockResolvedValue();
    vi.spyOn(useAppStore.getState(), "launchWorkspace").mockResolvedValue();

    await launchWorkspaceByName("Dev");

    expect(reload).not.toHaveBeenCalled();
  });

  it("uses the event name the backend emits for forwarded requests", () => {
    expect(CLI_WORKSPACE_REQUESTED_EVENT).toBe("cli-workspace-requested");
  });
});
