/**
 * Runtime wire-contract tests for the IPC layer (audit MOCK-005, #3837).
 *
 * The ts-rs bindings in `src/types/generated/` make `tsc` catch a *renamed*
 * Rust field, but not a serde-only change to what the backend actually puts on
 * the wire — a `skip_serializing_if` turning `null` into an absent key, a serde
 * `rename` of an enum variant, a flattened catch-all map that starts or stops
 * spilling keys. So instead of hand-typed `invoke` responses, every test here
 * feeds the real `src/services` wrapper the **golden JSON the Rust types
 * serialize**: `src/test/fixtures/wire/*.json`, written by the
 * `ipc_wire_fixtures` test in `src-tauri/src/ipc_wire_fixtures.rs` and kept
 * current by the `code-quality` CI job. The assertions pin the wrapper's output
 * (and, where a helper consumes it, what that helper derives), so a serde change
 * that regenerates a fixture fails here.
 *
 * Keys are pinned as exact sorted key sets where presence matters: that is what
 * turns "absent" vs "`null`" vs "renamed" into a test failure.
 *
 * No runtime decoder (zod etc.) is used: every IPC DTO is already a ts-rs type,
 * so a second, hand-maintained runtime schema would duplicate the contract,
 * and decoding on every IPC call would put a cost on hot paths such as the
 * projection frames. These fixtures verify the same thing in CI at zero runtime
 * cost.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";

import agentFixture from "@/test/fixtures/wire/agent.json";
import connectionsFixture from "@/test/fixtures/wire/connections.json";
import openPortsFixture from "@/test/fixtures/wire/open_ports.json";
import projectionFixture from "@/test/fixtures/wire/projection.json";
import sessionFixture from "@/test/fixtures/wire/session.json";
import settingsFixture from "@/test/fixtures/wire/settings.json";
import transfersFixture from "@/test/fixtures/wire/transfers.json";
import workspaceFixture from "@/test/fixtures/wire/workspace.json";

/** The channels `TauriTransport.subscribe` opens, so a test can push frames. */
const channels: Array<{ onmessage: (frame: unknown) => void }> = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: (frame: unknown) => void = () => {};
    constructor() {
      channels.push(this);
    }
  },
}));

import {
  connectAgent,
  createTerminal,
  getSettings,
  listAgentConnections,
  loadConnectionsAndFolders,
  transferList,
} from "./api";
import { networkOpenPorts } from "./networkApi";
import { loadWorkspace } from "./workspaceApi";
import { ProjectionClient } from "./transport/ProjectionClient";
import { TauriTransport } from "./transport/TauriTransport";
import { isTerminalTransferState } from "@/types/transfer";
import {
  buildTabGroupsFromWorkspace,
  countWorkspaceTabs,
  getWorkspaceLeaves,
} from "@/utils/workspaceLayout";
import type { PanelNode } from "@/types/terminal";

const mockedInvoke = vi.mocked(invoke);

/** Respond to the next `invoke` with a golden wire fixture. */
function respondWith(fixture: unknown): void {
  mockedInvoke.mockResolvedValueOnce(fixture);
}

function keys(value: object): string[] {
  return Object.keys(value).sort();
}

beforeEach(() => {
  mockedInvoke.mockReset();
  channels.length = 0;
});

describe("wire contract: connections / folders load", () => {
  it("decodes the serialized ConnectionData", async () => {
    respondWith(connectionsFixture.loadConnectionsAndFolders);
    const data = await loadConnectionsAndFolders();

    expect(mockedInvoke).toHaveBeenCalledWith("load_connections_and_folders");
    expect(keys(data)).toEqual(["agents", "connections", "externalErrors", "folders"]);

    const [full, bare] = data.connections;
    expect(keys(full)).toEqual([
      "config",
      "folderId",
      "icon",
      "id",
      "name",
      "sourceFile",
      "terminalOptions",
    ]);
    expect(full.config.type).toBe("ssh");
    // The legacy key is rewritten on the way through the backend.
    expect(full.config.config).toMatchObject({ autoReconnect: true, port: 2222 });
    expect(full.config.config).not.toHaveProperty("resilientReconnect");
    expect(full.terminalOptions).toMatchObject({
      cursorStyle: "bar",
      lineEnding: "crlf",
      lineHeight: 1.25,
      fontSize: 14,
    });
    // An unmodelled terminal option rides the flatten catch-all verbatim.
    expect(full.terminalOptions).toHaveProperty("futureTerminalOption", { nested: [1, 2] });
    expect(full.sourceFile).toBe("/home/me/shared/team.json");

    // Unset optionals are ABSENT; `folderId` is present-as-null.
    expect(keys(bare)).toEqual(["config", "folderId", "id", "name"]);
    expect(bare.folderId).toBeNull();
    expect(bare.config).toEqual({ type: "local", config: {} });

    const [root, nested] = data.folders;
    expect(keys(root)).toEqual(["id", "isExpanded", "name", "parentId"]);
    expect(root.parentId).toBeNull();
    expect(root.isExpanded).toBe(true);
    expect(nested.parentId).toBe("Work");

    const [agent] = data.agents;
    expect(keys(agent)).toEqual(["agentSettings", "config", "id", "name"]);
    expect(agent.config).toMatchObject({ host: "pi.local", port: 22, authMethod: "password" });
    expect(agent.config).not.toHaveProperty("password");
    expect(agent.agentSettings).toMatchObject({
      enableMonitoring: true,
      logLevel: "info",
      verboseTracing: false,
    });

    expect(data.externalErrors).toEqual([
      { filePath: "/home/me/broken.json", error: "expected value at line 1 column 1" },
    ]);
  });
});

describe("wire contract: session create", () => {
  it("returns the backend's session id string for local and agent tabs", async () => {
    respondWith(sessionFixture.createConnection);
    const local = await createTerminal({ type: "local", config: {} });
    expect(local).toBe("3f2b8c1e-5a4d-4e7b-9c0a-1d2e3f4a5b6c");
    expect(mockedInvoke).toHaveBeenLastCalledWith(
      "create_connection",
      expect.objectContaining({ typeId: "local", agentId: null })
    );

    respondWith(sessionFixture.createConnection);
    const remote = await createTerminal({
      type: "remote-session",
      config: { agentId: "agent-pi", sessionType: "serial", port: "/dev/ttyUSB0" },
    });
    expect(remote).toBe(local);
    expect(mockedInvoke).toHaveBeenLastCalledWith(
      "create_connection",
      expect.objectContaining({ typeId: "serial", agentId: "agent-pi" })
    );
  });

  it("names the saved connection a session is opened for, and only then (#3876)", async () => {
    respondWith(sessionFixture.createConnection);
    await createTerminal({ type: "ssh", config: {} }, undefined, false, false, false, "Work/files");
    expect(mockedInvoke).toHaveBeenLastCalledWith(
      "create_connection",
      expect.objectContaining({ typeId: "ssh", savedConnectionId: "Work/files" })
    );

    respondWith(sessionFixture.createConnection);
    await createTerminal({ type: "local", config: {} });
    const args = mockedInvoke.mock.lastCall?.[1] as Record<string, unknown>;
    expect(args).not.toHaveProperty("savedConnectionId");
  });
});

describe("wire contract: agent connect / definitions", () => {
  const agentConfig = { host: "pi.local", port: 22, username: "pi", authMethod: "key" as const };

  it("decodes a current agent's connect result", async () => {
    respondWith(agentFixture.connectAgent);
    const result = await connectAgent("agent-pi", agentConfig);

    expect(keys(result)).toEqual(["agentVersion", "capabilities", "protocolVersion"]);
    expect(result.protocolVersion).toBe("0.9.0");
    expect(result.capabilities.maxSessions).toBe(16);
    expect(result.capabilities.availableShells).toEqual(["/bin/bash", "/bin/zsh"]);
    expect(result.capabilities.dockerAvailable).toBe(true);
    expect(result.capabilities.toolStreaming).toBe(true);
    expect(result.capabilities.connectionTypes[0]).toMatchObject({
      typeId: "local",
      displayName: "Local Shell",
    });
  });

  it("re-serializes an older agent's omitted capabilities explicitly", async () => {
    respondWith(agentFixture.connectAgentLegacy);
    const result = await connectAgent("agent-old", agentConfig);

    // `#[serde(default)]` fields come back present (empty / false / ""), never
    // absent, even though the generated type marks them optional.
    expect(keys(result.capabilities)).toEqual([
      "agentVersion",
      "availableDockerImages",
      "availableSerialPorts",
      "availableShells",
      "connectionTypes",
      "dockerAvailable",
      "embeddedServerActivity",
      "fileRanges",
      "maxSessions",
      "monitoringSupported",
      "outputFlow",
      "sessionFiles",
      "sessionMonitoring",
      "sessionProcesses",
      "toolStreaming",
      "unattendedConnect",
    ]);
    expect(result.capabilities.availableShells).toEqual([]);
    expect(result.capabilities.dockerAvailable).toBe(false);
    expect(result.capabilities.agentVersion).toBe("");
  });

  it("decodes saved definitions with null vs absent optionals", async () => {
    respondWith(agentFixture.listAgentConnections);
    const { connections, folders } = await listAgentConnections("agent-pi");
    const [serial, shell] = connections;

    expect(mockedInvoke).toHaveBeenCalledWith("list_agent_connections", { agentId: "agent-pi" });
    expect(folders).toEqual([]);
    expect(keys(serial)).toEqual([
      "config",
      "folderId",
      "icon",
      "id",
      "name",
      "persistent",
      "sessionType",
      "sourceFile",
      "terminalOptions",
    ]);
    expect(serial.sessionType).toBe("serial");
    expect(serial.config).toEqual({ port: "/dev/ttyUSB0", baudRate: 115200, dataBits: 8 });
    expect(serial.terminalOptions).toEqual({ fontSize: 12, cursorBlink: false });

    expect(keys(shell)).toEqual(["config", "folderId", "id", "name", "persistent", "sessionType"]);
    expect(shell.folderId).toBeNull();
  });
});

describe("wire contract: settings", () => {
  it("decodes the serialized AppSettings", async () => {
    respondWith(settingsFixture.getSettings);
    const settings = await getSettings();

    expect(mockedInvoke).toHaveBeenCalledWith("get_settings");
    // Lenient enums serialize as their string forms.
    expect(settings.theme).toBe("custom:midnight");
    expect(settings.cursorStyle).toBe("underline");
    expect(settings.restoreLastSessionMode).toBe("always");
    expect(settings.defaultLineEnding).toBe("crlf");
    // Numbers, including a meaningful zero, stay present.
    expect(settings.fontSize).toBe(13);
    expect(settings.lineHeight).toBe(1.5);
    expect(settings.credentialAutoLockMinutes).toBe(0);
    // `default_true` flags are always emitted; an explicit false survives.
    expect(settings.powerMonitoringEnabled).toBe(false);
    expect(settings.warnLargePortScan).toBe(true);
    expect(settings.confirmCloseTabOnShortcut).toBe(true);
    expect(settings.externalConnectionFiles).toEqual([
      { path: "/home/me/team.json", enabled: false },
    ]);
    expect(settings.fileLanguageMappings).toEqual({ "*.conf": "ini" });
    // Unset `Option` fields are absent, not null.
    for (const absent of ["defaultUser", "defaultShell", "customThemes", "layout"]) {
      expect(settings).not.toHaveProperty(absent);
    }
    // A non-optional nested struct is always present with its defaults.
    expect(settings.updates).toEqual({ autoCheck: true });
    // A key from a newer build survives through the flatten catch-all.
    expect(settings).toHaveProperty("futureSettingFromNewerBuild", { enabled: true });
  });
});

describe("wire contract: workspace load", () => {
  it("decodes the nested layout union and builds tab groups from it", async () => {
    respondWith(workspaceFixture.loadWorkspace);
    const workspace = await loadWorkspace("ws-1");

    expect(mockedInvoke).toHaveBeenCalledWith("load_workspace", { workspaceId: "ws-1" });
    expect(keys(workspace)).toEqual(["description", "id", "name", "tabGroups"]);
    const [main, scratch] = workspace.tabGroups;
    expect(main.layout.type).toBe("split");
    expect(countWorkspaceTabs(main.layout)).toBe(3);
    expect(getWorkspaceLeaves(main.layout)).toHaveLength(3);
    expect(keys(scratch)).toEqual(["layout", "name"]);

    // Resolve the tabs against the other fixtures — saved connections and a
    // connected agent's definitions — exactly as a workspace launch does.
    const { connections, agents } = connectionsFixture.loadConnectionsAndFolders;
    const groups = buildTabGroupsFromWorkspace(
      workspace.tabGroups,
      connections as Parameters<typeof buildTabGroupsFromWorkspace>[1],
      "zsh",
      {
        agents: agents.map((a) => ({ id: a.id, name: a.name, connected: true })),
        definitions: {
          "agent-pi": agentFixture.listAgentConnections.connections.map((d) => ({
            id: d.id,
            name: d.name,
            sessionType: d.sessionType,
            persistent: d.persistent,
            config: d.config as Record<string, unknown>,
          })),
        },
      }
    );

    expect(groups.map((g) => [g.name, g.color])).toEqual([
      ["Main", "#ff8800"],
      ["Scratch", undefined],
    ]);
    const root = groups[0].rootPanel;
    expect(root.type).toBe("split");
    const leaves = collectLeaves(root);
    const [buildTab, inlineTab] = leaves[0].tabs;
    expect(buildTab.title).toBe("build");
    expect(buildTab.connectionType).toBe("ssh");
    expect(buildTab.initialCommand).toBe("make release");
    expect(inlineTab.connectionType).toBe("local");
    const [agentTab] = leaves[1].tabs;
    expect(agentTab.contentType).toBe("terminal");
    expect(agentTab.config).toMatchObject({
      type: "remote-session",
      config: { agentId: "agent-pi", sessionType: "serial", serialPort: "/dev/ttyUSB0" },
    });
    expect(collectLeaves(groups[1].rootPanel)[0].tabs[0].connectionType).toBe("local");
  });
});

function collectLeaves(node: PanelNode): Extract<PanelNode, { type: "leaf" }>[] {
  if (node.type === "leaf") return [node];
  return node.children.flatMap(collectLeaves);
}

describe("wire contract: transfer snapshot", () => {
  it("decodes the registry's snapshots", async () => {
    respondWith(transfersFixture.transferList);
    const [active, cancelled] = await transferList("sess-1");

    expect(mockedInvoke).toHaveBeenCalledWith("transfer_list", { sessionId: "sess-1" });
    expect(keys(active)).toEqual([
      "attempt",
      "direction",
      "fileName",
      "maxAttempts",
      "path",
      "sessionId",
      "settled",
      "speed",
      "state",
      "total",
      "transferId",
      "transferred",
    ]);
    // u64 byte counts above 2^32 arrive as exact JS numbers.
    expect(active.transferred).toBe(4_294_967_313);
    expect(active.total).toBe(6_442_450_944);
    expect(active.direction).toBe("download");
    expect(active.state).toBe("active");
    expect(isTerminalTransferState(active.state)).toBe(false);

    // An empty path is skipped on the wire.
    expect(cancelled).not.toHaveProperty("path");
    expect(cancelled.direction).toBe("upload");
    expect(cancelled.state).toBe("cancelled");
    expect(isTerminalTransferState(cancelled.state)).toBe(true);
    expect(cancelled.settled).toBe(true);
  });
});

describe("wire contract: open ports", () => {
  it("decodes ports with null (not absent) owner fields", async () => {
    respondWith(openPortsFixture.networkOpenPorts);
    const [tcp, udp] = await networkOpenPorts();

    expect(mockedInvoke).toHaveBeenCalledWith("network_open_ports");
    expect(tcp).toEqual({
      protocol: "TCP",
      localAddr: "127.0.0.1:5432",
      pid: 4242,
      process: "postgres",
    });
    expect(keys(udp)).toEqual(["localAddr", "pid", "process", "protocol"]);
    expect(udp.protocol).toBe("UDP");
    expect(udp.pid).toBeNull();
    expect(udp.process).toBeNull();
  });
});

describe("wire contract: projection snapshot / diff frames", () => {
  it("adopts the subscribe snapshot and applies the backend-computed diff", async () => {
    respondWith(projectionFixture.subscribeSnapshot);
    const client = new ProjectionClient(new TauriTransport("client-1"), "wire-contract");
    await client.start();

    expect(mockedInvoke).toHaveBeenCalledWith(
      "projection_subscribe",
      expect.objectContaining({ region: "wire-contract", clientId: "client-1" })
    );
    expect(client.state).toEqual({
      version: 7,
      view: projectionFixture.subscribeSnapshot.view,
    });

    // The diff arrives on the region channel exactly as the backend emits it.
    expect(channels).toHaveLength(1);
    channels[0].onmessage(projectionFixture.channelDiff);

    // Applied in place — a misread `kind`/`baseVersion`/op would fall back to a
    // resync instead of reaching the expected view.
    expect(mockedInvoke).not.toHaveBeenCalledWith("projection_resync", expect.anything());
    expect(client.state).toEqual({ version: 8, view: projectionFixture.expectedView });
    client.stop();
  });

  it("reads an up-to-date resync as null", async () => {
    respondWith(projectionFixture.resyncCurrent);
    const result = await new TauriTransport("client-1").resync("wire-contract", 8);
    expect(result).toBeNull();
    expect(mockedInvoke).toHaveBeenCalledWith("projection_resync", {
      region: "wire-contract",
      have: 8,
    });
  });
});
