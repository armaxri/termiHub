import { describe, expect, it } from "vitest";
import { buildTemplatedConnections, isHostTemplate } from "./fleetOnboard";
import type { ConnectionTypeInfo, InventoryHost, SavedConnection } from "@/types/connection";

/** A minimal SSH connection usable as a template. */
function sshTemplate(overrides: Partial<SavedConnection> = {}): SavedConnection {
  return {
    id: "tmpl-1",
    name: "Prod template",
    folderId: null,
    config: {
      type: "ssh",
      config: {
        host: "template.example.com",
        port: 22,
        username: "deploy",
        authMethod: "key",
        keyPath: "/home/me/.ssh/id_fleet",
      },
    },
    ...overrides,
  };
}

function rows(...hosts: Partial<InventoryHost>[]): InventoryHost[] {
  return hosts.map((h) => ({ host: h.host ?? "h", label: h.label ?? h.host ?? "h", ...h }));
}

describe("buildTemplatedConnections", () => {
  it("builds one connection per CSV row, reusing the template settings", () => {
    const { connections } = buildTemplatedConnections(
      rows({ host: "web1.internal", label: "Web 1" }, { host: "web2.internal", label: "Web 2" }),
      sshTemplate(),
      null,
      []
    );

    expect(connections).toHaveLength(2);
    for (const c of connections) {
      expect(c.config.type).toBe("ssh");
      expect(c.config.config.username).toBe("deploy");
      expect(c.config.config.authMethod).toBe("key");
      expect(c.config.config.keyPath).toBe("/home/me/.ssh/id_fleet");
      expect(c.folderId).toBeNull();
    }
    expect(connections[0].name).toBe("Web 1");
    expect(connections[0].config.config.host).toBe("web1.internal");
    expect(connections[1].config.config.host).toBe("web2.internal");
  });

  it("lands connections in the chosen folder", () => {
    const { connections } = buildTemplatedConnections(
      rows({ host: "h1" }),
      sshTemplate(),
      "Work/Fleet",
      []
    );
    expect(connections[0].folderId).toBe("Work/Fleet");
  });

  it("clones settings so per-host overrides do not leak between connections", () => {
    const { connections } = buildTemplatedConnections(
      rows({ host: "a", port: 2201 }, { host: "b" }),
      sshTemplate(),
      null,
      []
    );
    expect(connections[0].config.config.port).toBe(2201);
    // The second host keeps the template default, unaffected by the first.
    expect(connections[1].config.config.port).toBe(22);
  });

  it("applies per-row port and username overrides", () => {
    const { connections } = buildTemplatedConnections(
      rows({ host: "db", port: 5432, username: "postgres" }),
      sshTemplate(),
      null,
      []
    );
    expect(connections[0].config.config.port).toBe(5432);
    expect(connections[0].config.config.username).toBe("postgres");
  });

  it("dedupes names within the target folder", () => {
    const existing = [
      {
        id: "e1",
        name: "Web 1",
        folderId: null,
        config: { type: "ssh", config: { host: "old.internal" } },
      } as SavedConnection,
    ];
    const { connections } = buildTemplatedConnections(
      rows({ host: "web1.internal", label: "Web 1" }),
      sshTemplate(),
      null,
      existing
    );
    expect(connections[0].name).toBe("Web 1 (2)");
  });

  it("skips hosts that already have a connection of the template type (dedupe on)", () => {
    const existing = [
      {
        id: "e1",
        name: "Existing web",
        folderId: null,
        config: { type: "ssh", config: { host: "web1.internal" } },
      } as SavedConnection,
    ];
    const { connections, skipped } = buildTemplatedConnections(
      rows({ host: "web1.internal", label: "Web 1" }, { host: "web2.internal", label: "Web 2" }),
      sshTemplate(),
      null,
      existing
    );
    expect(skipped).toHaveLength(1);
    expect(skipped[0].host).toBe("web1.internal");
    expect(connections).toHaveLength(1);
    expect(connections[0].config.config.host).toBe("web2.internal");
  });

  it("host dedupe is case-insensitive and folder-scoped", () => {
    const existing = [
      {
        id: "e1",
        name: "Existing",
        folderId: "Work",
        config: { type: "ssh", config: { host: "HOST.Internal" } },
      } as SavedConnection,
    ];
    // Same host but a different folder → not a duplicate.
    const other = buildTemplatedConnections(
      rows({ host: "host.internal" }),
      sshTemplate(),
      "Other",
      existing
    );
    expect(other.connections).toHaveLength(1);
    // Same folder, case-insensitive match → skipped.
    const same = buildTemplatedConnections(
      rows({ host: "host.internal" }),
      sshTemplate(),
      "Work",
      existing
    );
    expect(same.connections).toHaveLength(0);
    expect(same.skipped).toHaveLength(1);
  });

  it("collapses duplicate hosts within the same batch", () => {
    const { connections } = buildTemplatedConnections(
      rows({ host: "dup.internal" }, { host: "dup.internal" }),
      sshTemplate(),
      null,
      []
    );
    expect(connections).toHaveLength(1);
  });

  it("can keep duplicates when dedupe is disabled", () => {
    const existing = [
      {
        id: "e1",
        name: "Existing",
        folderId: null,
        config: { type: "ssh", config: { host: "web1.internal" } },
      } as SavedConnection,
    ];
    const { connections, skipped } = buildTemplatedConnections(
      rows({ host: "web1.internal", label: "Web 1" }),
      sshTemplate(),
      null,
      existing,
      { dedupe: false }
    );
    expect(skipped).toHaveLength(0);
    expect(connections).toHaveLength(1);
  });

  it("carries the template icon and terminal options onto each connection", () => {
    const { connections } = buildTemplatedConnections(
      rows({ host: "h1" }),
      sshTemplate({ icon: "server", terminalOptions: { fontSize: 14 } as never }),
      null,
      []
    );
    expect(connections[0].icon).toBe("server");
    expect(connections[0].terminalOptions).toEqual({ fontSize: 14 });
  });

  it("skips rows with a blank host", () => {
    const { connections } = buildTemplatedConnections(
      rows({ host: "  ", label: "blank" }, { host: "real" }),
      sshTemplate(),
      null,
      []
    );
    expect(connections).toHaveLength(1);
    expect(connections[0].config.config.host).toBe("real");
  });
});

describe("isHostTemplate", () => {
  function typeInfo(typeId: string, fieldKeys: string[]): ConnectionTypeInfo {
    return {
      typeId,
      displayName: typeId,
      icon: typeId,
      schema: {
        groups: [
          {
            key: "main",
            label: "Main",
            fields: fieldKeys.map((key) => ({
              key,
              label: key,
              fieldType: { type: "text" },
              required: false,
            })),
          },
        ],
      },
      capabilities: {} as ConnectionTypeInfo["capabilities"],
    } as ConnectionTypeInfo;
  }

  function conn(type: string, config: Record<string, unknown>): SavedConnection {
    return { id: `c-${type}`, name: type, folderId: null, config: { type, config } };
  }

  const registry = [
    typeInfo("ssh", ["host", "port", "username"]),
    typeInfo("telnet", ["host", "port"]),
    typeInfo("serial", ["port", "baudRate"]),
    typeInfo("local", ["shell"]),
  ];

  it("accepts types whose registry schema has a host field", () => {
    expect(isHostTemplate(conn("ssh", {}), registry)).toBe(true);
    expect(isHostTemplate(conn("telnet", {}), registry)).toBe(true);
  });

  it("rejects types whose registry schema has no host field", () => {
    expect(isHostTemplate(conn("serial", { port: "/dev/ttyUSB0" }), registry)).toBe(false);
    expect(isHostTemplate(conn("local", { shell: "zsh" }), registry)).toBe(false);
  });

  it("falls back to the saved settings when the type is not in the registry", () => {
    expect(isHostTemplate(conn("plugin-x", { host: "a" }), [])).toBe(true);
    expect(isHostTemplate(conn("plugin-y", { shell: "zsh" }), [])).toBe(false);
  });
});
