/** The file server's editor tab (#6028, slice 7). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";

const { openFolder } = vi.hoisted(() => ({ openFolder: vi.fn() }));
vi.mock("@/services/nativeDialog", () => ({ open: openFolder }));
vi.mock("@/services/embeddedServerApi", () => ({
  listNetworkInterfaces: vi.fn(() =>
    Promise.resolve([
      { name: "Loopback", addr: "127.0.0.1" },
      { name: "All interfaces", addr: "0.0.0.0" },
      { name: "en0", addr: "192.168.1.20" },
    ])
  ),
}));
vi.mock("@/components/RunLocationSelect", () => ({
  RunLocationSelect: (props: {
    value: { kind: string };
    onChange: (host: object) => void;
    "data-testid"?: string;
  }) => (
    <div data-testid={props["data-testid"]} data-value={props.value.kind}>
      <button
        aria-label="agent"
        data-testid="pick-agent"
        onClick={() => props.onChange({ kind: "agent", agentId: "a1" })}
      />
      <button
        aria-label="this"
        data-testid="pick-this"
        onClick={() => props.onChange({ kind: "thisComputer" })}
      />
    </div>
  ),
}));

import { toast } from "@/components/ui";
import { listNetworkInterfaces } from "@/services/embeddedServerApi";
import { useAppStore } from "@/store/appStore";
import { seedAgentsRegion, setupAgentsRegion } from "@/test/agentsRegionTestHarness";
import { checkA11y } from "@/test/axe";
import { byTestId, pressEscape, typeInto, unsavedPromptOpen } from "@/test/dirtyDismiss";
import { flushAsync } from "@/test/flushAsync";
import { hydrateInDestination, moveTabs, seedSingleTab } from "@/test/formDraftMove";
import { seedLayoutState } from "@/test/layoutState";
import { leaveField } from "@/test/leaveField";
import { withTooltip } from "@/test/tooltip";
import type { EmbeddedServerConfig, ServerStatus } from "@/types/embeddedServer";
import type { ServerEditorMeta, TerminalTab } from "@/types/terminal";
import { clearEditorBuffers, readFormDraft } from "@/utils/editorBufferRegistry";
import { FileServerEditor } from "./FileServerEditor";

const TAB = "tab-1";
const PANEL = "panel-1";
const DOCS: EmbeddedServerConfig = {
  id: "srv-1",
  name: "Docs",
  serverType: "http",
  rootDirectory: "/srv/docs",
  bindHost: "127.0.0.1",
  port: 8080,
  autoStart: false,
  readOnly: true,
  directoryListing: true,
};

const toastError = vi.spyOn(toast, "error");

let container: HTMLDivElement;
let root: Root;
const actions = {
  saveEmbeddedServer: vi.fn(async (_config: EmbeddedServerConfig) => {}),
  startEmbeddedServer: vi.fn(async (_id: string) => {}),
  restartEmbeddedServer: vi.fn(async (_id: string) => {}),
  closeTab: vi.fn(),
};

async function render(meta: Partial<ServerEditorMeta> = {}, tabId = TAB) {
  await act(async () =>
    root.render(
      withTooltip(
        <FileServerEditor
          key={tabId}
          tabId={tabId}
          meta={{ serverId: null, ...meta }}
          isVisible={true}
        />
      )
    )
  );
  await flushAsync();
}

function seed(servers: EmbeddedServerConfig[], status?: ServerStatus) {
  const stats = { bytesSent: 0, bytesReceived: 0, activeConnections: 0, totalConnections: 0 };
  useAppStore.setState({
    embeddedServers: servers,
    embeddedServerStates: status
      ? Object.fromEntries(servers.map(({ id }) => [id, { serverId: id, status, stats }]))
      : {},
  });
}

const field = (name: string) => byTestId(`server-dialog-${name}`);
const press = async (name: string) => {
  await act(async () => field(name)!.click());
  await flushAsync();
};
const type = (name: string, value: string) => typeInto(`server-dialog-${name}`, value);
const note = () => byTestId("server-editor-note")?.textContent;
const saved = () => actions.saveEmbeddedServer.mock.calls[0][0];
const checked = (name: string) => field(name)?.getAttribute("aria-checked");

setupAgentsRegion();

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  clearEditorBuffers();
  useAppStore.setState({ ...useAppStore.getInitialState(), ...actions });
  seedAgentsRegion({ remoteAgents: [{ id: "a1", name: "Build server", config: {} } as never] });
  seedLayoutState({
    rootPanel: {
      type: "leaf",
      id: PANEL,
      tabs: [{ id: TAB }],
      activeTabId: TAB,
    } as never,
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useAppStore.setState(useAppStore.getInitialState());
});

describe("a new one", () => {
  it("is named by what it is for, and asks for the folder first", async () => {
    await render({ serverType: "http" });
    expect(byTestId("server-editor-title")?.textContent).toBe("Open it in a browser");
    expect(byTestId("server-editor")?.textContent).toContain("New service · Web server (HTTP)");
    expect(document.activeElement).toBe(field("root"));
    const order = [
      "root",
      "port",
      "bind-here",
      "dirlisting",
      "signin",
      "name",
      "description",
      "autostart",
      "save-start",
    ].map((name) => field(name)!);
    for (let i = 1; i < order.length; i += 1) {
      const follows = order[i - 1].compareDocumentPosition(order[i]);
      expect(follows & Node.DOCUMENT_POSITION_FOLLOWING, String(i)).toBeTruthy();
    }
  });

  it("saves, and closes its tab without a toast (#5859)", async () => {
    await render({ serverType: "ftp" });
    type("root", "/srv/fw");
    type("description", "  Lab   firmware ");
    expect((field("description") as HTMLInputElement).maxLength).toBe(80);
    await press("save");
    expect(saved()).toMatchObject({
      name: "fw",
      description: "Lab firmware",
      serverType: "ftp",
      rootDirectory: "/srv/fw",
      bindHost: "127.0.0.1",
      port: 2121,
      readOnly: true,
      ftpAuth: { type: "anonymous" },
      host: { kind: "thisComputer" },
    });
    expect(saved().id).not.toBe("");
    expect(actions.closeTab).toHaveBeenCalledWith(TAB, PANEL);
    expect(actions.startEmbeddedServer).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("is started by its primary button, and by Enter", async () => {
    await render();
    type("root", "/srv/fw");
    expect(field("save-start")?.className).toContain("primary");
    act(
      () =>
        void field("root")!.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
        )
    );
    await flushAsync();
    expect(actions.startEmbeddedServer).toHaveBeenCalledWith(saved().id);
    expect(actions.closeTab).toHaveBeenCalled();
  });

  it("says when it did not start, and when it was not saved", async () => {
    actions.startEmbeddedServer.mockRejectedValueOnce(new Error("no"));
    await render();
    type("root", "/srv/fw");
    await press("save-start");
    expect(toastError).toHaveBeenCalledWith("Failed to start fw");
    actions.closeTab.mockClear();
    actions.saveEmbeddedServer.mockRejectedValueOnce(new Error("disk full"));
    await press("save");
    expect(actions.closeTab).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenLastCalledWith("disk full");
  });

  it("says what is missing beside Save, and at the field once it is tried (#5917)", async () => {
    await render({ serverType: "tftp" });
    expect(note()).toBe("Still needed: the folder, who can open it");
    expect(field("save-start")?.getAttribute("aria-disabled")).toBe("true");
    expect(byTestId("server-editor")?.textContent).not.toContain("Choose the folder to share.");
    await press("save-start");
    expect(actions.saveEmbeddedServer).not.toHaveBeenCalled();
    expect(byTestId("server-editor")?.textContent).toContain("Choose the folder to share.");
    expect(byTestId("server-editor")?.textContent).toContain("Choose who can open it.");
    expect(document.activeElement).toBe(field("root"));
    type("root", "/srv/fw");
    await press("bind-network");
    expect(note()).toBe("");
    type("port", "");
    expect(note()).toBe("Still needed: the port");
    expect((field("port") as HTMLInputElement).value).toBe("");
  });

  it("takes the chosen folder, and its name when there is none yet", async () => {
    await render();
    openFolder.mockResolvedValueOnce("C:\\share\\Firmware files\\");
    await press("root-choose");
    expect(openFolder).toHaveBeenCalledWith({ directory: true, multiple: false });
    expect((field("root") as HTMLInputElement).value).toBe("C:\\share\\Firmware files\\");
    expect((field("name") as HTMLInputElement).value).toBe("Firmware files");
    openFolder.mockResolvedValueOnce("/srv/other");
    await press("root-choose");
    expect((field("name") as HTMLInputElement).value).toBe("Firmware files");
    openFolder.mockResolvedValueOnce(null);
    await press("root-choose");
    expect((field("root") as HTMLInputElement).value).toBe("/srv/other");
    expect(note()).toBe("");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("is called like a typed folder when the user leaves the field", async () => {
    await render();
    type("root", "/srv/fw");
    expect((field("name") as HTMLInputElement).value).toBe("");
    leaveField(field("root")!);
    expect((field("name") as HTMLInputElement).value).toBe("fw");
  });

  it("can be changed to another kind, which keeps what was chosen", async () => {
    await render({ serverType: "http" });
    expect(field("proto-ftp")).toBeNull();
    await act(async () => byTestId("server-editor-change-type")!.click());
    expect(byTestId("server-editor-change-type")).toBeNull();
    await press("proto-tftp");
    expect(byTestId("server-editor-title")?.textContent).toBe("Give files to a device");
    expect((field("port") as HTMLInputElement).value).toBe("6969");
    expect(checked("bind-here")).toBe("false");
    expect(field("signin")).toBeNull();
    expect(field("dirlisting")).toBeNull();
    // Chosen now, although it is another kind's preset.
    await press("bind-here");
    await press("proto-ftp");
    await press("proto-tftp");
    expect(checked("bind-here")).toBe("true");
    await press("bind-network");
    await press("proto-ftp");
    expect(checked("bind-network")).toBe("true");
    expect(field("signin")).not.toBeNull();
  });

  it("says in plain words what decides between the kinds (#6036)", async () => {
    await render();
    await act(async () => byTestId("server-editor-change-type")!.click());
    const card = (kind: string) => field(`proto-${kind}`)!.closest("label")?.textContent ?? "";
    expect(card("http") || field("proto-http")!.textContent).toContain(
      "Web server (HTTP). Anyone with a browser; nothing to install"
    );
  });
});

describe("who can open it", () => {
  it("is said in words, with the address that comes out of it", async () => {
    await render({ serverType: "http" });
    expect(checked("bind-here")).toBe("true");
    expect(field("address-preview")?.textContent).toBe(
      "Address: http://localhost:8080 · only this computer"
    );
    expect(field("warning")).toBeNull();
    await press("bind-network");
    expect(field("address-preview")?.textContent).toBe(
      "Address: http://192.168.1.20:8080 · anyone on your network"
    );
    expect(field("warning")?.textContent).toContain("Anyone on your network can get these files.");
    await press("signin");
    expect(field("warning")?.textContent).toContain("They need the password.");
    type("port", "");
    expect(field("address-preview")).toBeNull();
  });

  it("warns of uploads only while they are allowed", async () => {
    await render({ serverType: "ftp" });
    expect(checked("can-download")).toBe("true");
    await press("bind-network");
    expect(field("warning")?.textContent).not.toContain("put files there");
    await press("can-upload");
    expect(field("warning")?.textContent).toContain("change them and put files there");
    type("root", "/srv/inbox");
    await press("save");
    expect(saved()).toMatchObject({ bindHost: "0.0.0.0", readOnly: false });
  });

  it("can be one address of this computer", async () => {
    await render();
    type("root", "/srv/docs");
    await press("bind-address");
    expect(field("address")?.getAttribute("data-value")).toBe("192.168.1.20");
    expect(field("warning")?.textContent).toContain("Anyone who reaches 192.168.1.20");
    await press("save");
    expect(saved().bindHost).toBe("192.168.1.20");
  });

  it("offers no address when this computer has none", async () => {
    vi.mocked(listNetworkInterfaces).mockRejectedValue(new Error("no"));
    await render();
    expect(field("bind-network")).not.toBeNull();
    expect(field("bind-address")).toBeNull();
    vi.mocked(listNetworkInterfaces).mockResolvedValue([{ name: "en0", addr: "192.168.1.20" }]);
  });

  it("says that no device reaches a private one", async () => {
    await render({ serverType: "tftp" });
    await press("bind-here");
    expect(field("address-preview")?.textContent).toContain("no device can reach it");
  });

  it("on an agent is about that machine, whose address is typed (F-8)", async () => {
    await render();
    type("root", "/srv/docs");
    await act(async () => byTestId("pick-agent")!.click());
    expect(field("root-choose")).toBeNull();
    expect(byTestId("server-editor")?.textContent).toContain("A folder on that machine");
    expect(byTestId("server-dialog-bind")?.textContent).toContain("Only that machine");
    expect(byTestId("server-dialog-bind")?.textContent).toContain(
      "Anyone who reaches that machine"
    );
    await press("bind-address");
    expect(field("address")?.tagName).toBe("INPUT");
    expect(note()).toBe("Still needed: who can open it");
    await press("save");
    // Once, at the field that is empty.
    const said = byTestId("server-editor")!.textContent!.split("Choose who can open it.");
    expect(said).toHaveLength(2);
    type("address", "10.0.0.5");
    expect(field("warning")?.textContent).toContain("Anyone who reaches 10.0.0.5");
    await press("save");
    expect(saved()).toMatchObject({
      bindHost: "10.0.0.5",
      host: { kind: "agent", agentId: "a1" },
    });
  });
});

describe("its port (V-002, V-003)", () => {
  it("is one that no service of this computer is set to", async () => {
    seed([
      DOCS,
      { ...DOCS, id: "srv-2", port: 8081 },
      { ...DOCS, id: "far", port: 8082, host: { kind: "agent", agentId: "a1" } as never },
    ]);
    await render({ serverType: "http" });
    expect((field("port") as HTMLInputElement).value).toBe("8082");
    expect(byTestId("server-dialog-port-taken")).toBeNull();
    // The kind's preset moves with it.
    await act(async () => byTestId("server-editor-change-type")!.click());
    await press("proto-ftp");
    expect((field("port") as HTMLInputElement).value).toBe("2121");
  });

  it("that another service is set to is said, with a free one", async () => {
    seed([DOCS]);
    await render({ serverType: "http" });
    type("port", "8080");
    expect(byTestId("server-dialog-port-taken")?.textContent).toBe(
      'Port 8080 is used by "Docs". Use 8081'
    );
    await press("use-port");
    expect((field("port") as HTMLInputElement).value).toBe("8081");
    expect(byTestId("server-dialog-port-taken")).toBeNull();
  });

  it("on another machine is not this computer's", async () => {
    seed([DOCS]);
    await render({ serverType: "http" });
    type("port", "8080");
    expect(byTestId("server-dialog-port-taken")).not.toBeNull();
    await act(async () => byTestId("pick-agent")!.click());
    expect(byTestId("server-dialog-port-taken")).toBeNull();
  });

  it("of the server itself is not taken, nor one on another machine", async () => {
    seed([DOCS]);
    await render({ serverId: "srv-1" });
    expect(byTestId("server-dialog-port-taken")).toBeNull();
    await act(async () => byTestId("pick-agent")!.click());
    type("port", "8080");
    expect(byTestId("server-dialog-port-taken")).toBeNull();
  });

  it("of a TFTP server says that devices ask on 69", async () => {
    await render({ serverType: "tftp" });
    expect(byTestId("server-dialog-tftp-port")?.textContent).toBe(
      "Devices usually ask on port 69. Set the device to port 6969, or use 69 here."
    );
    type("port", "69");
    expect(byTestId("server-dialog-tftp-port")?.textContent).toContain(
      "Devices ask on this port by default."
    );
    await render({ serverType: "http" }, "tab-2");
    expect(byTestId("server-dialog-tftp-port")).toBeNull();
  });
});

describe("the sign-in", () => {
  it("asks for both, and saves them for the kind", async () => {
    await render({ serverType: "http" });
    type("root", "/srv/docs");
    await press("signin");
    expect(note()).toBe("Still needed: a user name, a password");
    type("username", "team");
    type("password", "secret");
    await press("save");
    expect(saved().httpAuth).toEqual({ username: "team", password: "secret" });
  });

  it("of a saved server keeps its password while the field is blank (#3514)", async () => {
    const asks = { ...DOCS, httpAuth: { username: "team", password: "" } };
    seed([asks]);
    await render({ serverId: "srv-1" });
    expect(checked("signin")).toBe("true");
    expect((field("password") as HTMLInputElement).placeholder).toBe("Saved, leave blank to keep");
    expect(note()).toBe("");
    type("name", "Docs 2");
    await press("save");
    expect(saved().httpAuth).toEqual({ username: "team", password: "" });
  });

  it("of a saved server of another kind needs a new password", async () => {
    seed([{ ...DOCS, httpAuth: { username: "team", password: "" } }]);
    await render({ serverId: "srv-1" });
    await act(async () => byTestId("server-editor-change-type")!.click());
    await press("proto-ftp");
    expect((field("password") as HTMLInputElement).placeholder).toBe("");
    expect(note()).toBe("Still needed: a password");
  });
});

describe("a saved one", () => {
  it("is called by its name, and keeps what the editor does not know", async () => {
    seed([{ ...DOCS, bindHost: "10.1.2.3", maxTransferBytes: 5 }]);
    await render({ serverId: "srv-1" });
    expect(byTestId("server-editor-title")?.textContent).toBe("Docs");
    expect(field("address")?.getAttribute("data-value")).toBe("10.1.2.3");
    // Focus without selecting: typing must not replace the folder (U-008).
    const folder = field("root") as HTMLInputElement;
    expect(document.activeElement).toBe(folder);
    expect(folder.selectionEnd! - folder.selectionStart!).toBe(0);
    type("name", "Docs 2");
    expect(field("save")?.className).toContain("primary");
    await press("save");
    expect(saved()).toMatchObject({
      id: "srv-1",
      name: "Docs 2",
      bindHost: "10.1.2.3",
      maxTransferBytes: 5,
    });
    expect(saved()).not.toHaveProperty("host");
  });

  it("keeps who can open it when its kind changes (#6076)", async () => {
    seed([DOCS]);
    await render({ serverId: "srv-1" });
    await act(async () => byTestId("server-editor-change-type")!.click());
    await press("proto-tftp");
    expect(checked("bind-here")).toBe("true");
  });

  it("is not reset by its state or its traffic", async () => {
    seed([DOCS], "running");
    await render({ serverId: "srv-1" });
    type("name", "Mine");
    act(() => seed([{ ...DOCS }], "running"));
    await flushAsync();
    expect((field("name") as HTMLInputElement).value).toBe("Mine");
  });

  it("that runs says when changes apply, and can be restarted with them", async () => {
    seed([DOCS], "running");
    await render({ serverId: "srv-1" });
    expect(note()).toBe("");
    type("port", "8090");
    expect(note()).toBe("Changes apply when it restarts.");
    expect(field("save-start")?.textContent).toBe("Save and restart");
    await press("save-start");
    expect(actions.restartEmbeddedServer).toHaveBeenCalledWith("srv-1");
    expect(actions.startEmbeddedServer).not.toHaveBeenCalled();
  });

  it("moves only when another machine is chosen, and says that it stops it", async () => {
    seed([DOCS], "running");
    await render({ serverId: "srv-1" });
    const hint = () => byTestId("server-dialog-runloc-field")?.textContent;
    expect(hint()).not.toContain("Saving stops it");
    await act(async () => byTestId("pick-agent")!.click());
    expect(hint()).toContain("It is running. Saving stops it");
    expect(note()).toBe("");
    await press("save");
    expect(saved().host).toEqual({ kind: "agent", agentId: "a1" });
  });

  it("that does not run is moved without a word", async () => {
    seed([DOCS], "stopped");
    await render({ serverId: "srv-1" });
    await act(async () => byTestId("pick-agent")!.click());
    expect(byTestId("server-dialog-runloc-field")?.textContent).not.toContain("Saving stops it");
  });

  it("on an unreadable machine keeps it", async () => {
    seed([{ ...DOCS, host: { kind: "moon" } as never }]);
    await render({ serverId: "srv-1" });
    expect(field("runloc")?.getAttribute("data-value")).toBe("unreadable");
    type("name", "Docs 2");
    await press("save");
    expect(saved()).not.toHaveProperty("host");
  });

  it("that arrives later fills the form", async () => {
    await render({ serverId: "srv-1" });
    act(() => seed([DOCS]));
    await flushAsync();
    expect((field("root") as HTMLInputElement).value).toBe("/srv/docs");
    expect(useAppStore.getState().editorDirtyTabs[TAB]).toBe(false);
  });
});

it.each(["http", "ftp"] as const)(
  "a copy of one with a password asks for it (#6028, F-4): %s",
  async (serverType) => {
    const auth =
      serverType === "http"
        ? { httpAuth: { username: "web", password: "" } }
        : { ftpAuth: { type: "credentials" as const, username: "web", password: "" } };
    const host = { kind: "agent", agentId: "a1" } as never;
    seed([{ ...DOCS, serverType, ...auth, host, autoStart: true, maxTransferBytes: 5 }]);
    await render({ copyOf: "srv-1" });
    expect(field("copy-hint")?.textContent).toContain("password");
    expect(note()).toBe("Still needed: a password");
    type("password", "new-secret");
    await press("save");
    expect(saved()).toMatchObject({
      name: "Copy of Docs",
      host,
      autoStart: false,
      maxTransferBytes: 5,
    });
    expect(saved().id).not.toBe("srv-1");
    expect(JSON.stringify(saved())).toContain("new-secret");
  }
);

describe("unsaved changes (F-11)", () => {
  const dirty = () => useAppStore.getState().editorDirtyTabs[TAB];

  it("mark the tab until they are taken back", async () => {
    await render();
    expect(dirty()).toBeFalsy();
    type("name", "x");
    expect(dirty()).toBe(true);
    type("name", "");
    expect(dirty()).toBe(false);
  });

  it.each([
    ["Cancel", () => press("cancel")],
    ["Escape", async () => pressEscape("server-dialog-name")],
  ])("are asked about on %s", async (_name, dismiss) => {
    await render();
    type("root", "/srv/docs");
    type("name", "Docs");
    await dismiss();
    await flushAsync();
    expect(actions.closeTab).not.toHaveBeenCalled();
    expect(unsavedPromptOpen()).toBe(true);
    await act(async () => byTestId("unsaved-changes-save-and-close")!.click());
    await flushAsync();
    expect(saved().name).toBe("Docs");
    expect(actions.closeTab).toHaveBeenCalledWith(TAB, PANEL);
  });

  it("can be dropped", async () => {
    await render();
    type("name", "Docs");
    await press("cancel");
    await act(async () => byTestId("unsaved-changes-just-close")!.click());
    expect(actions.saveEmbeddedServer).not.toHaveBeenCalled();
    expect(actions.closeTab).toHaveBeenCalledWith(TAB, PANEL);
  });

  it("without any it closes at once", async () => {
    await render();
    await press("cancel");
    expect(actions.closeTab).toHaveBeenCalledWith(TAB, PANEL);
  });
});

describe("a tab that moves to another window (#4500)", () => {
  const tab = (meta: ServerEditorMeta): TerminalTab => ({
    id: "tab-src",
    sessionId: null,
    title: "New file server",
    connectionType: "local",
    contentType: "server-editor",
    config: { type: "local", config: {} },
    panelId: "panel-src",
    isActive: true,
    serverEditorMeta: meta,
  });

  it.each([null, "srv-1"])("takes its draft along, but no password (%s)", async (serverId) => {
    if (serverId) seed([DOCS]);
    seedSingleTab(tab({ serverId }));
    await render({ serverId }, "tab-src");
    type("name", "Mine");
    await press("signin");
    type("username", "team");
    type("password", "secret");
    const record = await moveTabs();
    expect(record.tab.editorDirty).toBe(true);
    expect(record.tab.formDraft?.kind).toBe("server-editor");
    expect(JSON.stringify(record)).not.toContain("secret");
    expect(record.tab.serverEditorMeta).toEqual({ serverId });

    act(() => root.unmount());
    root = createRoot(container);
    const moved = hydrateInDestination(record, "panel-dst");
    expect(useAppStore.getState().tabContent[moved].serverEditorMeta).toEqual({ serverId });
    await render({ serverId }, moved);
    expect((field("name") as HTMLInputElement).value).toBe("Mine");
    expect((field("username") as HTMLInputElement).value).toBe("team");
    expect((field("password") as HTMLInputElement).value).toBe("");
    expect(useAppStore.getState().editorDirtyTabs[moved]).toBe(true);
    expect(actions.saveEmbeddedServer).not.toHaveBeenCalled();
  });
});

it("a tab without changes moves without a draft", async () => {
  seed([DOCS]);
  seedSingleTab({ id: "tab-src", contentType: "server-editor" } as TerminalTab);
  await render({ serverId: "srv-1" }, "tab-src");
  expect(readFormDraft("tab-src")).toBeNull();
  type("name", "Mine");
  expect(readFormDraft("tab-src")).not.toBeNull();
});

it("a moved draft is kept when its server arrives later", async () => {
  const tab = {
    id: "tab-src",
    sessionId: null,
    title: "Edit: Docs",
    connectionType: "local",
    contentType: "server-editor",
    config: { type: "local", config: {} },
    panelId: "panel-src",
    isActive: true,
    serverEditorMeta: { serverId: "srv-1" },
  } as TerminalTab;
  seed([DOCS]);
  seedSingleTab(tab);
  await render({ serverId: "srv-1" }, "tab-src");
  type("name", "Mine");
  const record = await moveTabs();
  act(() => root.unmount());
  root = createRoot(container);
  act(() => seed([]));
  const moved = hydrateInDestination(record, "panel-dst");
  await render({ serverId: "srv-1" }, moved);
  act(() => seed([DOCS]));
  await flushAsync();
  expect((field("name") as HTMLInputElement).value).toBe("Mine");
  expect(useAppStore.getState().editorDirtyTabs[moved]).toBe(true);
});

it("has no accessibility violations, also with a warning and an error", async () => {
  await render({ serverType: "ftp" });
  await press("bind-network");
  await press("signin");
  await press("save-start");
  await act(async () => byTestId("server-editor-change-type")!.click());
  expect(await checkA11y()).toHaveNoViolations();
});
