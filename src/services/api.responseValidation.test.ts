import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockedInvoke = vi.mocked(invoke);

// Import after mock setup.
import {
  replaySessionScrollback,
  getAgentSessionBuffer,
  isImportError,
  importConnectionsWithCredentials,
  previewImport,
  transferPause,
  transferResume,
  transferCancel,
  transferRetry,
  transferList,
  sshHostKeyDecision,
  sshKeyboardInteractiveRespond,
  cancelConnectAgent,
  pruneDeadAgents,
  rdpTrustList,
  rdpTrustForget,
  sshTrustList,
  sshTrustForget,
  shutdownAgent,
  createAgentFolder,
  probeRemoteAgent,
  exportConnectionsEncrypted,
  resolveContainerSpawn,
  resolveShellSpawn,
  importSshConfigHosts,
  importInventoryHosts,
  connectAgent,
  adoptPersistentSession,
  listPersistentSessions,
  deployAgent,
  updateAgent,
  validatePlugin,
  assessPluginTrust,
  getPluginSettings,
  updatePluginSettings,
  installPlugin,
  getSettings,
} from "./api";

// A minimal RemoteAgentConfig literal accepted by the typed wrappers (mirrors
// the shape the existing api.test.ts feeds detectAgentArch).
const agentConfig = {
  host: "pi.local",
  port: 22,
  username: "pi",
  authMethod: "key" as const,
};

describe("api response-validation (TFE-004)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // These wrappers ship raw bytes over IPC as a compact base64 string (PERF-009
  // — was a JSON number-array, ~4–6x wire bloat) and must decode them back into
  // a Uint8Array for callers. Assert the command + arg shape AND that the base64
  // response decodes byte-exact — including high bytes (>127) and non-UTF8
  // sequences that a naive string round-trip would corrupt. `bytes` spans the
  // 0x00–0xFF boundary; `b64` is its canonical base64 (the exact wire form the
  // Rust `encode_bytes_base64` emits).
  describe("byte-array response transformation", () => {
    const bytes = [0x00, 0x41, 0x7f, 0x80, 0xc0, 0xfe, 0xff];
    const b64 = "AEF/gMD+/w==";

    it("replaySessionScrollback decodes base64 into an exact Uint8Array", async () => {
      mockedInvoke.mockResolvedValue(b64);

      const result = await replaySessionScrollback("sess-1");

      expect(mockedInvoke).toHaveBeenCalledWith("replay_session_scrollback", {
        sessionId: "sess-1",
      });
      expect(result).toBeInstanceOf(Uint8Array);
      expect(Array.from(result)).toEqual(bytes);
    });

    it("replaySessionScrollback yields an empty Uint8Array for an empty buffer", async () => {
      mockedInvoke.mockResolvedValue("");

      const result = await replaySessionScrollback("sess-empty");

      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(0);
    });

    it("getAgentSessionBuffer decodes base64 into an exact Uint8Array", async () => {
      mockedInvoke.mockResolvedValue(b64);

      const result = await getAgentSessionBuffer("agent-sess-1");

      expect(mockedInvoke).toHaveBeenCalledWith("get_agent_session_buffer", {
        sessionId: "agent-sess-1",
      });
      expect(result).toBeInstanceOf(Uint8Array);
      expect(Array.from(result)).toEqual(bytes);
    });
  });

  // isImportError is the pure classifier callers branch on to decide whether a
  // caught rejection is a structured backend ImportError (I18N-010). Its branch
  // logic is response validation in its own right.
  describe("isImportError type guard", () => {
    it("accepts a wrongPassword ImportError", () => {
      expect(isImportError({ kind: "wrongPassword", message: "nope" })).toBe(true);
    });

    it("accepts an other ImportError", () => {
      expect(isImportError({ kind: "other", message: "disk full" })).toBe(true);
    });

    it("rejects an object with an unknown kind", () => {
      expect(isImportError({ kind: "somethingElse", message: "x" })).toBe(false);
    });

    it("rejects null, a string, and a plain Error", () => {
      expect(isImportError(null)).toBe(false);
      expect(isImportError("wrongPassword")).toBe(false);
      expect(isImportError(new Error("boom"))).toBe(false);
    });
  });

  // importConnectionsWithCredentials rejects with the backend's structured
  // ImportError; the wrapper must surface it unchanged so a caller can re-prompt
  // on wrongPassword via isImportError.
  describe("importConnectionsWithCredentials", () => {
    it("returns the ImportResult on success with the right arg shape", async () => {
      const importResult = { connectionsImported: 3, credentialsImported: 2 };
      mockedInvoke.mockResolvedValue(importResult);

      const result = await importConnectionsWithCredentials('{"connections":[]}', "pw");

      expect(mockedInvoke).toHaveBeenCalledWith("import_connections_with_credentials", {
        json: '{"connections":[]}',
        importPassword: "pw",
      });
      expect(result).toEqual(importResult);
    });

    it("propagates a structured ImportError rejection recognised by isImportError", async () => {
      const err = { kind: "wrongPassword", message: "wrong password" };
      mockedInvoke.mockRejectedValue(err);

      await expect(importConnectionsWithCredentials('{"connections":[]}', "bad")).rejects.toEqual(
        err
      );

      // The caller's branch: the rejection is a recognised ImportError.
      const caught = await importConnectionsWithCredentials('{"connections":[]}', "bad").catch(
        (e: unknown) => e
      );
      expect(isImportError(caught)).toBe(true);
    });

    it("forwards a null import password (no-decrypt import)", async () => {
      mockedInvoke.mockResolvedValue({ connectionsImported: 1, credentialsImported: 0 });

      await importConnectionsWithCredentials('{"connections":[]}', null);

      expect(mockedInvoke).toHaveBeenCalledWith("import_connections_with_credentials", {
        json: '{"connections":[]}',
        importPassword: null,
      });
    });
  });

  describe("previewImport", () => {
    it("returns the parsed preview and forwards the json", async () => {
      const preview = {
        connectionCount: 4,
        folderCount: 1,
        agentCount: 0,
        hasEncryptedCredentials: true,
      };
      mockedInvoke.mockResolvedValue(preview);

      const result = await previewImport('{"connections":[]}');

      expect(mockedInvoke).toHaveBeenCalledWith("preview_import", {
        json: '{"connections":[]}',
      });
      expect(result).toEqual(preview);
    });
  });

  // The transfer-queue controls return a boolean the caller MUST honour: `false`
  // is a no-op (unknown/finished id or an unsupported legacy transfer) and the
  // caller must not report success on it (audit FEC-004 / UX-016). Assert both
  // the truthy state-change and the falsy no-op are returned faithfully.
  describe("transfer-queue control boolean semantics", () => {
    const cases: Array<[string, (id: string) => Promise<boolean>, string]> = [
      ["transferPause", transferPause, "transfer_pause"],
      ["transferResume", transferResume, "transfer_resume"],
      ["transferCancel", transferCancel, "transfer_cancel"],
      ["transferRetry", transferRetry, "transfer_retry"],
    ];

    for (const [name, fn, command] of cases) {
      it(`${name} returns true on a real state change with the transfer id`, async () => {
        mockedInvoke.mockResolvedValue(true);

        const result = await fn("transfer-1");

        expect(mockedInvoke).toHaveBeenCalledWith(command, { transferId: "transfer-1" });
        expect(result).toBe(true);
      });

      it(`${name} returns false on a no-op (unknown/finished id)`, async () => {
        mockedInvoke.mockResolvedValue(false);

        const result = await fn("transfer-gone");

        expect(result).toBe(false);
      });
    }

    it("transferList forwards a session filter and returns snapshots", async () => {
      const snapshots = [
        {
          transferId: "t1",
          sessionId: "s1",
          direction: "download",
          fileName: "a.bin",
          state: "active",
          settled: false,
          transferred: 10,
          total: 100,
          speed: 5,
          attempt: 0,
          maxAttempts: 3,
        },
      ];
      mockedInvoke.mockResolvedValue(snapshots);

      const result = await transferList("s1");

      expect(mockedInvoke).toHaveBeenCalledWith("transfer_list", { sessionId: "s1" });
      expect(result).toEqual(snapshots);
    });

    it("transferList passes an undefined session filter when omitted", async () => {
      mockedInvoke.mockResolvedValue([]);

      const result = await transferList();

      expect(mockedInvoke).toHaveBeenCalledWith("transfer_list", { sessionId: undefined });
      expect(result).toEqual([]);
    });
  });

  // Boolean "was it found / did anything change" wrappers whose result gates UI.
  describe("found/changed boolean wrappers", () => {
    it("sshHostKeyDecision returns true when a prompt matched", async () => {
      mockedInvoke.mockResolvedValue(true);

      const result = await sshHostKeyDecision("prompt-1", true, true);

      expect(mockedInvoke).toHaveBeenCalledWith("ssh_host_key_decision", {
        promptId: "prompt-1",
        accept: true,
        remember: true,
      });
      expect(result).toBe(true);
    });

    it("sshHostKeyDecision returns false for a stale/unknown prompt id", async () => {
      mockedInvoke.mockResolvedValue(false);

      const result = await sshHostKeyDecision("stale", false, false);

      expect(result).toBe(false);
    });

    it("sshKeyboardInteractiveRespond forwards answers and null for cancel", async () => {
      mockedInvoke.mockResolvedValue(true);

      await expect(sshKeyboardInteractiveRespond("ki-1", ["123456"])).resolves.toBe(true);
      expect(mockedInvoke).toHaveBeenCalledWith("ssh_keyboard_interactive_respond", {
        promptId: "ki-1",
        responses: ["123456"],
      });

      mockedInvoke.mockResolvedValue(false);
      await expect(sshKeyboardInteractiveRespond("stale", null)).resolves.toBe(false);
      expect(mockedInvoke).toHaveBeenLastCalledWith("ssh_keyboard_interactive_respond", {
        promptId: "stale",
        responses: null,
      });
    });

    it("cancelConnectAgent reports whether a connecting agent was found", async () => {
      mockedInvoke.mockResolvedValue(true);
      await expect(cancelConnectAgent("agent-1")).resolves.toBe(true);
      expect(mockedInvoke).toHaveBeenCalledWith("cancel_connect_agent", { agentId: "agent-1" });

      mockedInvoke.mockResolvedValue(false);
      await expect(cancelConnectAgent("agent-2")).resolves.toBe(false);
    });

    it("pruneDeadAgents returns the pruned ids", async () => {
      mockedInvoke.mockResolvedValue(["dead-1", "dead-2"]);

      const result = await pruneDeadAgents();

      expect(mockedInvoke).toHaveBeenCalledWith("prune_dead_agents");
      expect(result).toEqual(["dead-1", "dead-2"]);
    });
  });

  // Trust-management wrappers: list returns the remembered hosts; forget defaults
  // the fingerprint to null (forget-whole-host) and returns whether anything was
  // removed.
  describe("trust management wrappers", () => {
    it("rdpTrustList returns remembered hosts", async () => {
      const hosts = [{ host: "10.0.0.1", fingerprints: ["aa:bb"] }];
      mockedInvoke.mockResolvedValue(hosts);

      const result = await rdpTrustList();

      expect(mockedInvoke).toHaveBeenCalledWith("rdp_trust_list");
      expect(result).toEqual(hosts);
    });

    it("rdpTrustForget forgets a single fingerprint when given one", async () => {
      mockedInvoke.mockResolvedValue(true);

      const result = await rdpTrustForget("10.0.0.1", "aa:bb");

      expect(mockedInvoke).toHaveBeenCalledWith("rdp_trust_forget", {
        host: "10.0.0.1",
        fingerprint: "aa:bb",
      });
      expect(result).toBe(true);
    });

    it("rdpTrustForget defaults the fingerprint to null (forget whole host)", async () => {
      mockedInvoke.mockResolvedValue(false);

      const result = await rdpTrustForget("unknown.host");

      expect(mockedInvoke).toHaveBeenCalledWith("rdp_trust_forget", {
        host: "unknown.host",
        fingerprint: null,
      });
      expect(result).toBe(false);
    });

    it("sshTrustList returns remembered hosts", async () => {
      const hosts = [{ host: "pi.local", fingerprints: ["SHA256:x"] }];
      mockedInvoke.mockResolvedValue(hosts);

      const result = await sshTrustList();

      expect(mockedInvoke).toHaveBeenCalledWith("ssh_trust_list");
      expect(result).toEqual(hosts);
    });

    it("sshTrustForget defaults the fingerprint to null and returns removed flag", async () => {
      mockedInvoke.mockResolvedValue(true);

      const result = await sshTrustForget("pi.local");

      expect(mockedInvoke).toHaveBeenCalledWith("ssh_trust_forget", {
        host: "pi.local",
        fingerprint: null,
      });
      expect(result).toBe(true);
    });
  });

  // Argument-defaulting: optional params that the wrapper must normalise to
  // `null` (never `undefined`) so the backend deserialises them.
  describe("null-defaulting argument shaping", () => {
    it("shutdownAgent defaults reason to null and returns detached count", async () => {
      mockedInvoke.mockResolvedValue(2);

      const result = await shutdownAgent("agent-1");

      expect(mockedInvoke).toHaveBeenCalledWith("shutdown_agent", {
        agentId: "agent-1",
        reason: null,
      });
      expect(result).toBe(2);
    });

    it("shutdownAgent forwards an explicit reason", async () => {
      mockedInvoke.mockResolvedValue(0);

      await shutdownAgent("agent-1", "user requested");

      expect(mockedInvoke).toHaveBeenCalledWith("shutdown_agent", {
        agentId: "agent-1",
        reason: "user requested",
      });
    });

    it("createAgentFolder defaults parentId to null and returns the folder", async () => {
      const folder = { id: "f1", name: "prod", parentId: null, isExpanded: false };
      mockedInvoke.mockResolvedValue(folder);

      const result = await createAgentFolder("agent-1", "prod");

      expect(mockedInvoke).toHaveBeenCalledWith("create_agent_folder", {
        agentId: "agent-1",
        name: "prod",
        parentId: null,
      });
      expect(result).toEqual(folder);
    });

    it("probeRemoteAgent defaults expectedVersion to null and returns the probe", async () => {
      const probe = {
        found: true,
        version: "1.2.3",
        remoteArch: "x86_64",
        remoteOs: "Linux",
        compatible: true,
      };
      mockedInvoke.mockResolvedValue(probe);

      const result = await probeRemoteAgent(agentConfig);

      expect(mockedInvoke).toHaveBeenCalledWith("probe_remote_agent", {
        config: agentConfig,
        expectedVersion: null,
      });
      expect(result).toEqual(probe);
    });

    it("exportConnectionsEncrypted forwards explicit nulls verbatim", async () => {
      mockedInvoke.mockResolvedValue('{"encrypted":true}');

      const result = await exportConnectionsEncrypted(null, null);

      expect(mockedInvoke).toHaveBeenCalledWith("export_connections_encrypted", {
        exportPassword: null,
        connectionIds: null,
      });
      expect(result).toBe('{"encrypted":true}');
    });

    it("resolveContainerSpawn defaults runtime to null and returns the spawn", async () => {
      const spawn = { settings: { image: "alpine" }, title: "alpine (Spawned)", spawned: true };
      mockedInvoke.mockResolvedValue(spawn);

      const result = await resolveContainerSpawn("/work");

      expect(mockedInvoke).toHaveBeenCalledWith("resolve_container_spawn", {
        location: "/work",
        entryId: undefined,
        containerImage: undefined,
        containerMount: undefined,
        runtime: null,
      });
      expect(result).toEqual(spawn);
    });

    it("resolveShellSpawn defaults shell to null and returns the spawn", async () => {
      const spawn = {
        type: "local",
        settings: { startingDirectory: "/work" },
        title: "work (Spawned)",
        spawned: true,
        missing: false,
      };
      mockedInvoke.mockResolvedValue(spawn);

      const result = await resolveShellSpawn("/work", undefined, undefined, "local");

      expect(mockedInvoke).toHaveBeenCalledWith("resolve_shell_spawn", {
        location: "/work",
        connection: undefined,
        entryId: undefined,
        kind: "local",
        shell: null,
      });
      expect(result).toEqual(spawn);
    });

    it("resolveShellSpawn propagates a rejection for an unresolvable spawn", async () => {
      mockedInvoke.mockRejectedValue("no such connection");

      await expect(resolveShellSpawn(undefined, "missing", undefined, "ssh")).rejects.toEqual(
        "no such connection"
      );
    });
  });

  // Importers differ deliberately: the SSH-config importer degrades to an empty
  // list on the backend (never errors), while the user-picked inventory importer
  // rejects so the caller can toast. Lock in the differing error contracts.
  describe("importers: degrade-to-empty vs reject", () => {
    it("importSshConfigHosts returns the resolved hosts", async () => {
      const hosts = [{ alias: "web", hops: [] }];
      mockedInvoke.mockResolvedValue(hosts);

      const result = await importSshConfigHosts();

      expect(mockedInvoke).toHaveBeenCalledWith("import_ssh_config_hosts");
      expect(result).toEqual(hosts);
    });

    it("importSshConfigHosts returns an empty list when nothing degrades from the backend", async () => {
      mockedInvoke.mockResolvedValue([]);

      const result = await importSshConfigHosts();

      expect(result).toEqual([]);
    });

    it("importInventoryHosts forwards the picked path and returns rows", async () => {
      const rows = [{ alias: "h1", host: "10.0.0.1" }];
      mockedInvoke.mockResolvedValue(rows);

      const result = await importInventoryHosts("/tmp/fleet.csv");

      expect(mockedInvoke).toHaveBeenCalledWith("import_inventory_hosts", {
        path: "/tmp/fleet.csv",
      });
      expect(result).toEqual(rows);
    });

    it("importInventoryHosts propagates a read/parse rejection (never degrades)", async () => {
      mockedInvoke.mockRejectedValue("cannot read inventory file");

      await expect(importInventoryHosts("/tmp/bad.csv")).rejects.toEqual(
        "cannot read inventory file"
      );
    });
  });

  // connectAgent defaults agentSettings to null and returns the capability
  // handshake result unchanged.
  describe("connectAgent", () => {
    it("defaults agentSettings to null and returns the connect result", async () => {
      const connectResult = {
        capabilities: { monitoring: true },
        agentVersion: "1.0.0",
        protocolVersion: "3",
      };
      mockedInvoke.mockResolvedValue(connectResult);

      const result = await connectAgent("agent-1", agentConfig);

      expect(mockedInvoke).toHaveBeenCalledWith("connect_agent", {
        agentId: "agent-1",
        config: agentConfig,
        agentSettings: null,
      });
      expect(result).toEqual(connectResult);
    });

    it("propagates a connect rejection", async () => {
      mockedInvoke.mockRejectedValue("ssh handshake failed");

      await expect(connectAgent("agent-1", agentConfig)).rejects.toEqual("ssh handshake failed");
    });
  });

  describe("persistent session wrappers", () => {
    it("adoptPersistentSession forwards ids and echoes the agent session id", async () => {
      mockedInvoke.mockResolvedValue("agent-sess-9");

      const result = await adoptPersistentSession("conn-1", "agent-1", "agent-sess-9");

      expect(mockedInvoke).toHaveBeenCalledWith("adopt_persistent_session", {
        connectionId: "conn-1",
        agentId: "agent-1",
        agentSessionId: "agent-sess-9",
      });
      expect(result).toBe("agent-sess-9");
    });

    it("listPersistentSessions returns the summaries", async () => {
      const sessions = [{ connectionId: "c1", sessionId: "s1", attachedTabCount: 2 }];
      mockedInvoke.mockResolvedValue(sessions);

      const result = await listPersistentSessions();

      expect(mockedInvoke).toHaveBeenCalledWith("list_persistent_sessions");
      expect(result).toEqual(sessions);
    });
  });

  // deploy/update return a discriminated union; the wrapper must return each
  // variant faithfully so the caller can branch on `kind` (deployed vs
  // otherHostsConnected vs coordinated).
  describe("agent deploy/update discriminated-union results", () => {
    it("deployAgent returns a deployed result", async () => {
      const deployed = {
        kind: "deployed",
        success: true,
        installedVersion: "1.2.3",
        installedPath: "/usr/local/bin/termihub-agent",
      };
      mockedInvoke.mockResolvedValue(deployed);

      const result = await deployAgent("agent-1", agentConfig, { remotePath: "/x" });

      expect(mockedInvoke).toHaveBeenCalledWith("deploy_agent", {
        agentId: "agent-1",
        config: agentConfig,
        deployConfig: { remotePath: "/x" },
      });
      expect(result).toEqual(deployed);
    });

    it("updateAgent returns an otherHostsConnected guard result", async () => {
      const guarded = {
        kind: "otherHostsConnected",
        hosts: [
          {
            clientId: "c1",
            client: "termihub-desktop",
            clientVersion: "1.0.0",
            connectedSince: "2026-01-01T00:00:00Z",
          },
        ],
      };
      mockedInvoke.mockResolvedValue(guarded);

      const result = await updateAgent("agent-1", agentConfig, {});

      expect(mockedInvoke).toHaveBeenCalledWith("update_agent", {
        agentId: "agent-1",
        config: agentConfig,
        deployConfig: {},
      });
      expect(result).toEqual(guarded);
    });

    it("updateAgent returns a coordinated result", async () => {
      const coordinated = {
        kind: "coordinated",
        applied: false,
        activeSessions: 1,
        notifiedClients: 2,
        allAcked: false,
        remainingClients: ["c2"],
      };
      mockedInvoke.mockResolvedValue(coordinated);

      const result = await updateAgent("agent-1", agentConfig, {});

      expect(result).toEqual(coordinated);
    });
  });

  // Plugin wrappers remap their public parameter name onto a different backend
  // arg key (filePath → `path`, pluginId → `id`). A regression here would call
  // the command with the wrong key shape — assert the remapping explicitly.
  describe("plugin command arg-key remapping", () => {
    it("validatePlugin sends filePath under the `path` key", async () => {
      const manifest = { id: "p1", name: "Plugin", version: "1.0.0" };
      mockedInvoke.mockResolvedValue(manifest);

      const result = await validatePlugin("/tmp/p1.termihub-plugin");

      expect(mockedInvoke).toHaveBeenCalledWith("validate_plugin", {
        path: "/tmp/p1.termihub-plugin",
      });
      expect(result).toEqual(manifest);
    });

    it("assessPluginTrust sends filePath under the `path` key", async () => {
      const trust = { status: "unsigned" };
      mockedInvoke.mockResolvedValue(trust);

      const result = await assessPluginTrust("/tmp/p1.termihub-plugin");

      expect(mockedInvoke).toHaveBeenCalledWith("assess_plugin_trust", {
        path: "/tmp/p1.termihub-plugin",
      });
      expect(result).toEqual(trust);
    });

    it("getPluginSettings sends pluginId under the `id` key", async () => {
      mockedInvoke.mockResolvedValue({ theme: "dark" });

      const result = await getPluginSettings("p1");

      expect(mockedInvoke).toHaveBeenCalledWith("get_plugin_settings", { id: "p1" });
      expect(result).toEqual({ theme: "dark" });
    });

    it("updatePluginSettings sends pluginId under the `id` key with settings", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await updatePluginSettings("p1", { theme: "light" });

      expect(mockedInvoke).toHaveBeenCalledWith("update_plugin_settings", {
        id: "p1",
        settings: { theme: "light" },
      });
    });

    it("installPlugin sends filePath under `path` with the trust-gate flags", async () => {
      const installed = {
        status: "installed",
        plugin: { id: "p1", name: "Plugin", version: "1.0.0", enabled: true },
      };
      mockedInvoke.mockResolvedValue(installed);

      const result = await installPlugin("/tmp/p1.termihub-plugin", true, false);

      expect(mockedInvoke).toHaveBeenCalledWith("install_plugin", {
        path: "/tmp/p1.termihub-plugin",
        acceptUntrusted: true,
        trustPublisher: false,
        confirmVersionChange: false,
        confirmSignerChange: false,
      });
      expect(result).toEqual(installed);
    });

    it("installPlugin forwards the version-change confirmation (PLG-012)", async () => {
      mockedInvoke.mockResolvedValue({ status: "installed", plugin: {} });

      await installPlugin("/tmp/p1.termihub-plugin", false, false, true);

      expect(mockedInvoke).toHaveBeenCalledWith("install_plugin", {
        path: "/tmp/p1.termihub-plugin",
        acceptUntrusted: false,
        trustPublisher: false,
        confirmVersionChange: true,
        confirmSignerChange: false,
      });
    });

    it("installPlugin forwards the signer-change confirmation (#3489)", async () => {
      mockedInvoke.mockResolvedValue({ status: "installed", plugin: {} });

      await installPlugin("/tmp/p1.termihub-plugin", false, false, false, true);

      expect(mockedInvoke).toHaveBeenCalledWith("install_plugin", {
        path: "/tmp/p1.termihub-plugin",
        acceptUntrusted: false,
        trustPublisher: false,
        confirmVersionChange: false,
        confirmSignerChange: true,
      });
    });
  });

  // A plain rejection from invoke must propagate untouched (no swallowing, no
  // re-wrapping) so callers can surface backend errors.
  describe("error propagation", () => {
    it("getSettings rejects with the backend error unchanged", async () => {
      mockedInvoke.mockRejectedValue("settings file corrupt");

      await expect(getSettings()).rejects.toEqual("settings file corrupt");
    });

    it("previewImport rejects with the backend error unchanged", async () => {
      mockedInvoke.mockRejectedValue("invalid import json");

      await expect(previewImport("not json")).rejects.toEqual("invalid import json");
    });
  });
});
