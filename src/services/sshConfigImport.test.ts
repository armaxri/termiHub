import { describe, it, expect } from "vitest";
import type { SavedConnection, SshConfigImportConnection } from "@/types/connection";
import {
  buildBulkSshConnections,
  importFolderOptions,
  resolveImportFolderId,
  ROOT_FOLDER_VALUE,
  uniqueConnectionName,
} from "./sshConfigImport";

function importConn(over: Partial<SshConfigImportConnection>): SshConfigImportConnection {
  return {
    name: "host",
    host: "host.internal",
    port: 22,
    username: "me",
    authMethod: "agent",
    proxyJump: [],
    ...over,
  };
}

function saved(over: Partial<SavedConnection>): SavedConnection {
  return {
    id: "conn-x",
    name: "existing",
    config: { type: "ssh", config: {} },
    folderId: null,
    ...over,
  };
}

describe("uniqueConnectionName", () => {
  it("returns the base name when it is free", () => {
    expect(uniqueConnectionName("web", new Set())).toBe("web");
  });

  it("appends an incrementing suffix past the first collision", () => {
    expect(uniqueConnectionName("web", new Set(["web"]))).toBe("web (2)");
    expect(uniqueConnectionName("web", new Set(["web", "web (2)"]))).toBe("web (3)");
  });
});

describe("buildBulkSshConnections", () => {
  it("maps host/port/user/auth into an SSH saved connection in the target folder", () => {
    const [conn] = buildBulkSshConnections(
      [importConn({ name: "web", host: "web.internal", port: 2022, username: "alice" })],
      "folder-1",
      []
    );
    expect(conn.name).toBe("web");
    expect(conn.folderId).toBe("folder-1");
    expect(conn.config).toEqual({
      type: "ssh",
      config: { host: "web.internal", port: 2022, username: "alice", authMethod: "agent" },
    });
  });

  it("includes keyPath only for key auth and carries the proxyJump chain", () => {
    const [withKey, agentDirect] = buildBulkSshConnections(
      [
        importConn({
          name: "a",
          authMethod: "key",
          keyPath: "/home/me/.ssh/id_a",
          proxyJump: [{ host: "bastion", port: 22, username: "bob", authMethod: "key" }],
        }),
        importConn({ name: "b", authMethod: "agent", keyPath: "/should/not/appear" }),
      ],
      null,
      []
    );
    const withKeyCfg = withKey.config.config as Record<string, unknown>;
    expect(withKeyCfg.keyPath).toBe("/home/me/.ssh/id_a");
    expect(withKeyCfg.proxyJump).toHaveLength(1);
    const agentCfg = agentDirect.config.config as Record<string, unknown>;
    expect(agentCfg.keyPath).toBeUndefined();
    expect(agentCfg.proxyJump).toBeUndefined();
  });

  it("disambiguates names against existing connections in the same folder only", () => {
    const existing = [
      saved({ id: "e1", name: "web", folderId: "f1" }),
      saved({ id: "e2", name: "web", folderId: "other" }),
    ];
    const [inF1] = buildBulkSshConnections([importConn({ name: "web" })], "f1", existing);
    expect(inF1.name).toBe("web (2)");
    const [inOther] = buildBulkSshConnections([importConn({ name: "web" })], "unused", existing);
    expect(inOther.name).toBe("web");
  });

  it("disambiguates duplicate names within the same batch", () => {
    const [first, second] = buildBulkSshConnections(
      [importConn({ name: "web" }), importConn({ name: "web" })],
      null,
      []
    );
    expect(first.name).toBe("web");
    expect(second.name).toBe("web (2)");
    expect(first.id).not.toBe(second.id);
  });
});

describe("importFolderOptions", () => {
  it("lists the root first then folders by full path", () => {
    const opts = importFolderOptions([
      { id: "child", name: "Child", parentId: "parent", isExpanded: false },
      { id: "parent", name: "Parent", parentId: null, isExpanded: false },
    ]);
    expect(opts[0]).toEqual({ value: ROOT_FOLDER_VALUE, label: "Connections (root)" });
    expect(opts.map((o) => o.label)).toContain("Parent / Child");
    expect(opts.find((o) => o.value === "parent")?.label).toBe("Parent");
  });
});

describe("resolveImportFolderId", () => {
  it("maps the root sentinel (and empty) to null, otherwise passes the id through", () => {
    expect(resolveImportFolderId(ROOT_FOLDER_VALUE)).toBeNull();
    expect(resolveImportFolderId("")).toBeNull();
    expect(resolveImportFolderId("f1")).toBe("f1");
  });
});
