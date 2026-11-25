import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RestoredStart } from "@/types/backup";

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn() }));
vi.mock("@/services/api", async () => ({
  ...(await vi.importActual<typeof import("@/services/api")>("@/services/api")),
  listRestoredOff: vi.fn(),
  dismissRestoredOff: vi.fn(),
}));
const win = vi.hoisted(() => ({ label: "main" }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));

import { dismissRestoredOff, listRestoredOff } from "@/services/api";
import { useAppStore } from "@/store/appStore";
import { seedConnectionsRegion, setupConnectionsRegion } from "@/test/connectionsHarness";
import { RestoredOffDialog } from "./RestoredOffDialog";
import { RestoredOffHost } from "./RestoredOffHost";

const entry = (section: string, over: Partial<RestoredStart> = {}): RestoredStart => ({
  section,
  id: "x",
  name: `The ${section}`,
  starts: ["When termiHub starts"],
  switches: ["autoStart"],
  existsHere: false,
  sameHere: false,
  onHere: false,
  ...over,
});
const ALL = [
  entry("schedules", { starts: ["Daily at 02:00 on G"], switches: ["enabled"] }),
  entry("automations", { starts: ["Hotkey F8"], switches: ["triggersEnabled"] }),
  entry("tunnels", { switches: ["autoStart", "startWithConnection"] }),
  entry("embeddedServers"),
];

setupConnectionsRegion();

let container: HTMLDivElement;
let root: Root;
const query = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = async (id: string) => {
  await act(async () => query(id)!.click());
};
const setScheduleEnabled = vi.fn();
const setWorkflowTriggersEnabled = vi.fn();
const saveTunnel = vi.fn();
const saveEmbeddedServer = vi.fn();

async function render(entries: RestoredStart[] = ALL) {
  vi.mocked(listRestoredOff).mockResolvedValue(entries);
  await act(async () => root.render(<RestoredOffHost />));
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of [setScheduleEnabled, setWorkflowTriggersEnabled, saveTunnel, saveEmbeddedServer])
    fn.mockReset().mockResolvedValue(undefined);
  win.label = "main";
  seedConnectionsRegion({
    connections: ["A", "B"].map((id) => ({
      id,
      name: `Host ${id}`,
      folderId: null,
      config: { type: "ssh", config: {} },
      sourceFile: null,
    })),
  } as never);
  useAppStore.setState({
    unlockDialogOpen: false,
    recoveryDialogOpen: false,
    setScheduleEnabled,
    setWorkflowTriggersEnabled,
    saveTunnel,
    saveEmbeddedServer,
    automations: [
      {
        id: "x",
        name: "Clean",
        tags: [],
        triggers: [],
        parameters: [],
        steps: Array.from({ length: 7 }, (_, i) => ({
          kind: "send-command",
          command: `cmd-${i}\u202e`,
        })),
        createdAt: "",
        updatedAt: "",
      },
    ] as never,
    schedules: [
      {
        id: "x",
        action: { kind: "automation", automationId: "x" },
        targets: { kind: "connections", connectionIds: ["A", "B"] },
        connectIfNeeded: true,
      },
    ] as never,
    tunnels: [{ id: "x", name: "T", autoStart: false, startWithConnection: false }] as never,
    embeddedServers: [{ id: "x", name: "F", autoStart: false }] as never,
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("what a restore left switched off (#6056)", () => {
  it("shows nothing when there is nothing", async () => {
    await render([]);
    expect(query("restored-off-dialog")).toBeNull();
  });

  it("asks in the main window only", async () => {
    win.label = "window-2";
    await render();
    expect(listRestoredOff).not.toHaveBeenCalled();
  });

  it.each(["unlockDialogOpen", "recoveryDialogOpen"] as const)("waits for %s", async (dialog) => {
    useAppStore.setState({ [dialog]: true });
    await render();
    expect(query("restored-off-dialog")).toBeNull();
    act(() => useAppStore.setState({ [dialog]: false }));
    expect(query("restored-off-dialog")).not.toBeNull();
  });

  it("lists what would start each, ticks nothing and names every step and host", async () => {
    await render();
    const row = query("restored-off-row-schedules-x")!;
    expect(row.textContent).toContain("The schedules");
    expect(row.textContent).toContain("Daily at 02:00 on G");
    expect(row.textContent).toContain("Connects to hosts that are not connected");
    expect(row.textContent).toContain("On Host A, Host B");
    expect(row.textContent).toContain("cmd-6\\u{202e}");
    expect(query("restored-off-row-automations-x")!.textContent).toContain("cmd-0");
    expect(query("restored-off-steps-tunnels-x")).toBeNull();
    expect(document.querySelectorAll('[data-state="checked"]')).toHaveLength(0);
    expect((query("restored-off-turn-on") as HTMLButtonElement).disabled).toBe(true);
  });

  it("says when a schedule would run nothing", async () => {
    await render();
    expect(query("restored-off-gone-schedules-x")).toBeNull();
    act(() => useAppStore.setState({ automations: [] }));
    expect(query("restored-off-gone-schedules-x")!.textContent).not.toBe("");
  });

  it("turns on what is ticked and is done with the rest", async () => {
    await render();
    await click("restored-off-check-tunnels-x");
    await click("restored-off-check-schedules-x");
    expect(query("restored-off-turn-on")!.textContent).toBe("Turn on 2");
    await click("restored-off-turn-on");
    expect(setScheduleEnabled).toHaveBeenCalledExactlyOnceWith("x", true, true);
    expect(saveTunnel).toHaveBeenCalledExactlyOnceWith({
      id: "x",
      name: "T",
      autoStart: true,
      startWithConnection: true,
    });
    expect(setWorkflowTriggersEnabled).not.toHaveBeenCalled();
    expect(saveEmbeddedServer).not.toHaveBeenCalled();
    expect(dismissRestoredOff).toHaveBeenCalledOnce();
    expect(query("restored-off-dialog")).toBeNull();
  });

  it("turns on triggers and file servers", async () => {
    await render();
    await click("restored-off-check-automations-x");
    await click("restored-off-check-embeddedServers-x");
    await click("restored-off-turn-on");
    expect(setWorkflowTriggersEnabled).toHaveBeenCalledExactlyOnceWith("x", true);
    expect(saveEmbeddedServer).toHaveBeenCalledExactlyOnceWith({
      id: "x",
      name: "F",
      autoStart: true,
    });
  });

  it("turns off a tick again", async () => {
    await render();
    await click("restored-off-check-tunnels-x");
    await click("restored-off-check-tunnels-x");
    expect((query("restored-off-turn-on") as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps all off", async () => {
    await render();
    await click("restored-off-keep");
    expect(dismissRestoredOff).toHaveBeenCalledOnce();
    expect(setScheduleEnabled).not.toHaveBeenCalled();
    expect(query("restored-off-dialog")).toBeNull();
  });

  it("closing it keeps the list for the next start", async () => {
    await render();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(query("restored-off-dialog")).toBeNull();
    expect(dismissRestoredOff).not.toHaveBeenCalled();
  });

  it("says what could not be turned on and keeps it listed", async () => {
    setScheduleEnabled.mockRejectedValue(new Error("no such host"));
    useAppStore.setState({ embeddedServers: [] });
    await render();
    for (const e of ALL) await click(`restored-off-check-${e.section}-x`);
    await click("restored-off-turn-on");
    const errors = [...document.querySelectorAll('[data-testid="restored-off-error"]')];
    expect(errors.map((e) => e.textContent)).toEqual([
      "“The schedules” stays off: no such host",
      "“The embeddedServers” stays off: the file server was not found.",
    ]);
    expect(query("restored-off-row-tunnels-x")).toBeNull();
    expect((query("restored-off-turn-on") as HTMLButtonElement).disabled).toBe(true);
    expect(query("restored-off-row-schedules-x")).not.toBeNull();
    expect(dismissRestoredOff).not.toHaveBeenCalled();
  });

  it("says when a tunnel is gone or the entry cannot be turned on", async () => {
    useAppStore.setState({ tunnels: [] });
    await render([entry("tunnels"), entry("later")]);
    await click("restored-off-check-tunnels-x");
    await click("restored-off-check-later-x");
    await click("restored-off-turn-on");
    expect(
      [...document.querySelectorAll('[data-testid="restored-off-error"]')].map((e) => e.textContent)
    ).toEqual([
      "“The tunnels” stays off: the tunnel was not found.",
      "“The later” stays off: it cannot be turned on from here.",
    ]);
  });

  it("opened again, it starts fresh", async () => {
    setScheduleEnabled.mockRejectedValue(new Error("no"));
    const show = (open: boolean) =>
      act(async () =>
        root.render(
          <RestoredOffDialog open={open} entries={ALL} onLater={vi.fn()} onDone={vi.fn()} />
        )
      );
    await show(true);
    await click("restored-off-check-schedules-x");
    await click("restored-off-turn-on");
    expect(query("restored-off-error")).not.toBeNull();
    await show(false);
    await show(true);
    expect(query("restored-off-error")).toBeNull();
  });

  it("a list that cannot be read asks nothing", async () => {
    vi.mocked(listRestoredOff).mockRejectedValue(new Error("x"));
    await act(async () => root.render(<RestoredOffHost />));
    expect(query("restored-off-dialog")).toBeNull();
  });
});
