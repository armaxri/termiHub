import { describe, it, expect } from "vitest";
import {
  getJumpHosts,
  hasJumpHost,
  jumpHostTooltip,
  jumpHostStatusLabel,
  jumpHostGatewayConnection,
  connectionPathLabel,
  sshJumpHostOptions,
  ambiguousConnectionIds,
  findJumpHostDependents,
  jumpHostInlineFields,
} from "./jumpHost";
import { ConnectionFolder, JumpHostConfig, SavedConnection } from "@/types/connection";
import { ConnectionConfig } from "@/types/terminal";
import type { SettingsSchema } from "@/types/schema";

function hop(host: string, username = "admin"): JumpHostConfig {
  return { host, port: 22, username, authMethod: "key" };
}

function sshConfig(settings: Record<string, unknown>): ConnectionConfig {
  return { type: "ssh", config: settings };
}

describe("getJumpHosts", () => {
  it("returns the proxyJump chain for an SSH connection", () => {
    const config = sshConfig({ host: "target", username: "deploy", proxyJump: [hop("bastion")] });
    expect(getJumpHosts(config)).toHaveLength(1);
    expect(getJumpHosts(config)[0].host).toBe("bastion");
  });

  it("returns an empty array for non-SSH connections", () => {
    const config: ConnectionConfig = { type: "telnet", config: { proxyJump: [hop("bastion")] } };
    expect(getJumpHosts(config)).toEqual([]);
  });

  it("returns an empty array when no proxyJump is set", () => {
    expect(getJumpHosts(sshConfig({ host: "target" }))).toEqual([]);
  });

  it("tolerates the legacy jumpHosts alias", () => {
    const config = sshConfig({ host: "target", jumpHosts: [hop("bastion")] });
    expect(getJumpHosts(config)).toHaveLength(1);
  });

  it("is safe for undefined/null configs", () => {
    expect(getJumpHosts(undefined)).toEqual([]);
    expect(getJumpHosts(null)).toEqual([]);
  });
});

describe("hasJumpHost", () => {
  it("is true only when a chain is present", () => {
    expect(hasJumpHost(sshConfig({ proxyJump: [hop("bastion")] }))).toBe(true);
    expect(hasJumpHost(sshConfig({}))).toBe(false);
  });
});

describe("jumpHostTooltip", () => {
  it("joins hops with arrows", () => {
    expect(jumpHostTooltip([hop("edge"), hop("bastion")])).toBe("Via: edge → bastion");
  });

  it("appends the target name when provided", () => {
    expect(jumpHostTooltip([hop("edge"), hop("bastion")], "db-server")).toBe(
      "Via: edge → bastion → db-server"
    );
  });

  it("is empty for no hops", () => {
    expect(jumpHostTooltip([])).toBe("");
  });
});

describe("jumpHostStatusLabel", () => {
  it("renders user@target via gateway", () => {
    const config = sshConfig({
      host: "app-server",
      username: "deploy",
      proxyJump: [hop("bastion")],
    });
    expect(jumpHostStatusLabel(config)).toBe("deploy@app-server via bastion");
  });

  it("joins multi-hop gateways", () => {
    const config = sshConfig({
      host: "db-server",
      username: "deploy",
      proxyJump: [hop("edge"), hop("bastion")],
    });
    expect(jumpHostStatusLabel(config)).toBe("deploy@db-server via edge → bastion");
  });

  it("falls back to host-only when username is absent", () => {
    const config = sshConfig({ host: "app-server", proxyJump: [hop("bastion")] });
    expect(jumpHostStatusLabel(config)).toBe("app-server via bastion");
  });

  it("is empty without a jump host", () => {
    expect(jumpHostStatusLabel(sshConfig({ host: "app-server" }))).toBe("");
  });
});

describe("jumpHostGatewayConnection", () => {
  function savedConn(settings: Record<string, unknown>): SavedConnection {
    return {
      id: "Work/app-server",
      name: "app-server",
      folderId: null,
      config: sshConfig(settings),
    };
  }

  function gatewayOf(result: ReturnType<typeof jumpHostGatewayConnection>): SavedConnection {
    if (!result || !("connection" in result))
      throw new Error(`no gateway: ${JSON.stringify(result)}`);
    return result.connection;
  }

  it("targets the (single) bastion directly with no further hops", () => {
    const gw = gatewayOf(
      jumpHostGatewayConnection(
        savedConn({ host: "app-server", username: "deploy", proxyJump: [hop("bastion")] })
      )
    );
    expect(gw.config.config.host).toBe("bastion");
    expect(gw.config.config.proxyJump).toBeUndefined();
    expect(gw.id).toBe("Work/app-server::jump-host");
    expect(gw.name).toContain("bastion");
  });

  it("targets the innermost gateway through the remaining outer hops", () => {
    const gw = gatewayOf(
      jumpHostGatewayConnection(
        savedConn({ host: "db", username: "deploy", proxyJump: [hop("edge"), hop("bastion")] })
      )
    );
    expect(gw.config.config.host).toBe("bastion");
    expect(gw.config.config.proxyJump).toHaveLength(1);
    expect((gw.config.config.proxyJump as JumpHostConfig[])[0].host).toBe("edge");
  });

  it("returns null when there is no jump host", () => {
    expect(jumpHostGatewayConnection(savedConn({ host: "app-server" }))).toBeNull();
  });

  // #3620: a saved-connection reference hop stores `host: ""` — the gateway must
  // be the referenced connection itself, not an empty-host synthetic one.
  describe("innermost hop referencing a saved connection", () => {
    const refHop: JumpHostConfig = {
      connectionId: "Infra/bastion",
      host: "",
      port: 22,
      username: "",
      authMethod: "key",
    };
    const bastion: SavedConnection = {
      id: "Infra/bastion",
      name: "bastion",
      folderId: "Infra",
      config: sshConfig({
        host: "bastion.example.com",
        port: 2222,
        username: "ops",
        authMethod: "password",
        savePassword: true,
      }),
    };

    it("opens the referenced connection (host, port, user, auth) under its own id", () => {
      const target = savedConn({ host: "db", proxyJump: [refHop] });
      const gw = gatewayOf(jumpHostGatewayConnection(target, [target, bastion]));
      expect(gw.config.type).toBe("ssh");
      expect(gw.config.config.host).toBe("bastion.example.com");
      expect(gw.config.config.port).toBe(2222);
      expect(gw.config.config.username).toBe("ops");
      expect(gw.config.config.authMethod).toBe("password");
      expect(gw.config.config.savePassword).toBe(true);
      expect(gw.config.config.proxyJump).toBeUndefined();
      // Its own id, so its saved credential resolves as for a direct connect.
      expect(gw.id).toBe("Infra/bastion");
      expect(gw.name).toBe("bastion (jump host)");
    });

    it("reaches the referenced gateway through the outer hops, then its own chain", () => {
      const chained: SavedConnection = {
        ...bastion,
        config: sshConfig({ ...bastion.config.config, proxyJump: [hop("dmz")] }),
      };
      const target = savedConn({ host: "db", proxyJump: [hop("edge"), refHop] });
      const gw = gatewayOf(jumpHostGatewayConnection(target, [target, chained]));
      expect(gw.config.config.host).toBe("bastion.example.com");
      const chain = gw.config.config.proxyJump as JumpHostConfig[];
      expect(chain.map((h) => h.host)).toEqual(["edge", "dmz"]);
    });

    it("refuses an unknown reference instead of opening an empty host", () => {
      const target = savedConn({ host: "db", proxyJump: [refHop] });
      const result = jumpHostGatewayConnection(target, [target]);
      expect(result).toEqual({ error: expect.stringContaining("'Infra/bastion' not found") });
    });

    it("refuses an id held by several connection files, naming them", () => {
      const target = savedConn({ host: "db", proxyJump: [refHop] });
      const external = { ...bastion, sourceFile: "/team/shared.json" };
      const result = jumpHostGatewayConnection(target, [target, bastion, external]);
      expect(result).not.toBeNull();
      expect("error" in result!).toBe(true);
      const { error } = result as { error: string };
      expect(error).toContain("ambiguous");
      expect(error).toContain("the main connection store");
      expect(error).toContain("/team/shared.json");
    });

    it("refuses a reference to a non-SSH connection", () => {
      const target = savedConn({ host: "db", proxyJump: [refHop] });
      const local: SavedConnection = { ...bastion, config: { type: "local", config: {} } };
      const result = jumpHostGatewayConnection(target, [target, local]);
      expect(result).toEqual({ error: expect.stringContaining("not an SSH connection") });
    });
  });
});

describe("connectionPathLabel", () => {
  const folders: ConnectionFolder[] = [
    { id: "Work", name: "Work", parentId: null, isExpanded: true },
    { id: "Work/Dev", name: "Dev", parentId: "Work", isExpanded: true },
  ];
  const conn = (id: string, name: string, folderId: string | null): SavedConnection => ({
    id,
    name,
    folderId,
    config: sshConfig({ host: "h" }),
  });

  it("builds a Folder / Sub / Name path", () => {
    expect(connectionPathLabel(conn("Work/Dev/bastion", "bastion", "Work/Dev"), folders)).toBe(
      "Work / Dev / bastion"
    );
  });

  it("uses just the name for a root connection", () => {
    expect(connectionPathLabel(conn("bastion", "bastion", null), folders)).toBe("bastion");
  });
});

describe("sshJumpHostOptions", () => {
  const folders: ConnectionFolder[] = [
    { id: "Work", name: "Work", parentId: null, isExpanded: true },
  ];
  const sshConn = (id: string, name: string, folderId: string | null): SavedConnection => ({
    id,
    name,
    folderId,
    config: sshConfig({ host: "h" }),
  });
  const localConn: SavedConnection = {
    id: "local",
    name: "local",
    folderId: null,
    config: { type: "local", config: {} },
  };

  it("lists only SSH connections, labelled by path, sorted", () => {
    const opts = sshJumpHostOptions(
      [sshConn("Work/b", "b", "Work"), localConn, sshConn("a", "a", null)],
      folders
    );
    expect(opts).toEqual([
      { id: "a", label: "a" },
      { id: "Work/b", label: "Work / b" },
    ]);
  });

  it("excludes the connection being edited (no self-reference)", () => {
    const opts = sshJumpHostOptions(
      [sshConn("me", "me", null), sshConn("gw", "gw", null)],
      [],
      "me"
    );
    expect(opts.map((o) => o.id)).toEqual(["gw"]);
  });

  it("offers external-file connections like main-store ones (#3602)", () => {
    const ext = { ...sshConn("ext-gw", "ext-gw", null), sourceFile: "/shared.json" };
    const opts = sshJumpHostOptions([sshConn("gw", "gw", null), ext], []);
    expect(opts).toEqual([
      { id: "ext-gw", label: "ext-gw" },
      { id: "gw", label: "gw" },
    ]);
  });

  it("collapses an id held by several files into one ambiguous option (#3602)", () => {
    const opts = sshJumpHostOptions(
      [
        sshConn("gw", "gw", null),
        { ...sshConn("gw", "gw", null), sourceFile: "/a.json" },
        { ...sshConn("gw", "gw", null), sourceFile: "/b.json" },
        sshConn("other", "other", null),
      ],
      []
    );
    expect(opts).toEqual([
      { id: "gw", label: "gw", ambiguous: true },
      { id: "other", label: "other" },
    ]);
  });
});

describe("ambiguousConnectionIds (#3619)", () => {
  const sshConn = (id: string, name: string, folderId: string | null): SavedConnection => ({
    id,
    name,
    folderId,
    config: sshConfig({ host: "h" }),
  });

  it("returns only the ids held by more than one connection", () => {
    const ids = ambiguousConnectionIds([
      sshConn("gw", "gw", null),
      { ...sshConn("gw", "gw", null), sourceFile: "/a.json" },
      sshConn("solo", "solo", null),
    ]);
    expect([...ids]).toEqual(["gw"]);
  });

  it("is empty when every id is unique", () => {
    expect(ambiguousConnectionIds([sshConn("a", "a", null), sshConn("b", "b", null)]).size).toBe(0);
  });
});

describe("findJumpHostDependents (#941)", () => {
  /** An SSH connection whose proxyJump chain is `chain`. */
  const conn = (id: string, chain: JumpHostConfig[]): SavedConnection => ({
    id,
    name: id,
    folderId: null,
    config: sshConfig(chain.length ? { proxyJump: chain } : {}),
  });
  const ref = (connectionId: string): JumpHostConfig => ({
    connectionId,
    host: "",
    port: 22,
    username: "",
    authMethod: "key",
  });

  it("finds connections that reference the target as a jump host", () => {
    const a = conn("A", [ref("bastion")]);
    const b = conn("B", [hop("inline-host"), ref("bastion")]);
    const c = conn("C", [hop("other")]);
    const deps = findJumpHostDependents([a, b, c, conn("bastion", [])], ["bastion"]);
    expect(deps.map((d) => d.id).sort()).toEqual(["A", "B"]);
  });

  it("returns nothing for an unreferenced connection (no false positives on inline hops)", () => {
    const a = conn("A", [hop("inline-bastion")]);
    expect(findJumpHostDependents([a, conn("lonely", [])], ["lonely"])).toEqual([]);
  });

  it("excludes connections within the deletion set (intra-set references don't count)", () => {
    // Deleting A and bastion together; A references bastion, but A is also going.
    const a = conn("A", [ref("bastion")]);
    const deps = findJumpHostDependents([a, conn("bastion", [])], ["A", "bastion"]);
    expect(deps).toEqual([]);
  });

  it("ignores a hop that references the target inline (no connectionId)", () => {
    const a = conn("A", [hop("bastion")]); // host "bastion", not a saved reference
    expect(findJumpHostDependents([a, conn("bastion", [])], ["bastion"])).toEqual([]);
  });

  it("tolerates the legacy jumpHosts key", () => {
    const legacy: SavedConnection = {
      id: "L",
      name: "L",
      folderId: null,
      config: { type: "ssh", config: { jumpHosts: [ref("bastion")] } },
    };
    expect(findJumpHostDependents([legacy], ["bastion"]).map((d) => d.id)).toEqual(["L"]);
  });
});

describe("jumpHostInlineFields", () => {
  const schema: SettingsSchema = {
    groups: [
      {
        key: "connection",
        label: "Connection",
        fields: [
          { key: "host", label: "Host", fieldType: { type: "text" }, required: true },
          { key: "port", label: "Port", fieldType: { type: "port" }, required: true },
          { key: "username", label: "Username", fieldType: { type: "text" }, required: true },
        ],
      },
      {
        key: "authentication",
        label: "Authentication",
        fields: [
          {
            key: "authMethod",
            label: "Method",
            fieldType: {
              type: "select",
              options: [
                { value: "key", label: "SSH Key" },
                { value: "password", label: "Password" },
                { value: "agent", label: "SSH Agent" },
              ],
            },
            required: true,
          },
          {
            key: "password",
            label: "Password",
            fieldType: { type: "password" },
            required: false,
            visibleWhen: { field: "authMethod", equals: "password" },
          },
          {
            key: "keyPath",
            label: "Key Path",
            fieldType: { type: "filePath", kind: "file" },
            required: false,
            visibleWhen: { field: "authMethod", equals: "key" },
          },
          // A field the jump host must NOT adopt — proves it picks a subset.
          { key: "savePassword", label: "Save", fieldType: { type: "boolean" }, required: false },
        ],
      },
    ],
  };

  it("sources the inline hop fields from the SSH schema in order, plus the connect timeout", () => {
    const fields = jumpHostInlineFields(schema);
    expect(fields.map((f) => f.key)).toEqual([
      "host",
      "port",
      "username",
      "authMethod",
      "keyPath",
      "password",
      "connectTimeoutSecs",
    ]);
  });

  it("carries the exact schema field objects (auth options, conditional visibility)", () => {
    const fields = jumpHostInlineFields(schema);
    const auth = fields.find((f) => f.key === "authMethod");
    // The auth options come straight from the schema — not a local copy.
    expect(auth?.fieldType).toEqual({
      type: "select",
      options: [
        { value: "key", label: "SSH Key" },
        { value: "password", label: "Password" },
        { value: "agent", label: "SSH Agent" },
      ],
    });
    expect(fields.find((f) => f.key === "password")?.visibleWhen).toEqual({
      field: "authMethod",
      equals: "password",
    });
    expect(fields.find((f) => f.key === "keyPath")?.visibleWhen).toEqual({
      field: "authMethod",
      equals: "key",
    });
  });

  it("does not adopt non-hop SSH fields such as savePassword", () => {
    const keys = jumpHostInlineFields(schema).map((f) => f.key);
    expect(keys).not.toContain("savePassword");
  });

  it("returns only the connect-timeout field when no SSH schema is available", () => {
    const fields = jumpHostInlineFields(undefined);
    expect(fields.map((f) => f.key)).toEqual(["connectTimeoutSecs"]);
  });
});
