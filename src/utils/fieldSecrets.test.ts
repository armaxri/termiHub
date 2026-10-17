import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/services/api", () => ({
  resolveFieldSecrets: vi.fn(),
  storeFieldSecrets: vi.fn(),
}));

import { resolveFieldSecrets as apiResolve, storeFieldSecrets } from "@/services/api";
import { useAppStore } from "@/store/appStore";
import type { LogEntry } from "@/types/terminal";
import { onFrontendLog } from "@/utils/frontendLog";
import type { SettingsSchema } from "@/types/schema";
import {
  hasFieldSecretsToSave,
  hopIdentity,
  neededFieldSecrets,
  resolveFieldSecrets,
  type ResolveFieldSecretsOptions,
} from "./fieldSecrets";

const mockedResolve = vi.mocked(apiResolve);
const mockedStore = vi.mocked(storeFieldSecrets);

/** A VNC-like schema: an SSH-tunnel group with its own auth select and password. */
const VNC: SettingsSchema = {
  groups: [
    {
      key: "connection",
      label: "Connection",
      fields: [
        { key: "host", label: "Host", fieldType: { type: "text" }, required: true },
        { key: "password", label: "Password", fieldType: { type: "password" }, required: false },
      ],
    },
    {
      key: "sshTunnel",
      label: "SSH Tunnel",
      fields: [
        { key: "useSshTunnel", label: "Tunnel", fieldType: { type: "boolean" }, required: false },
        {
          key: "sshAuthMethod",
          label: "SSH Auth",
          fieldType: {
            type: "select",
            options: [
              { value: "password", label: "Password" },
              { value: "key", label: "Key" },
            ],
          },
          required: false,
          visibleWhen: { field: "useSshTunnel", equals: true },
        },
        {
          key: "sshPassword",
          label: "SSH Password",
          fieldType: { type: "password" },
          required: false,
          visibleWhen: { field: "useSshTunnel", equals: true },
        },
      ],
    },
  ],
} as unknown as SettingsSchema;

/** A plugin schema with a required secret. */
const PLUGIN: SettingsSchema = {
  groups: [
    {
      key: "config",
      label: "Configuration",
      fields: [
        { key: "apiToken", label: "API Token", fieldType: { type: "password" }, required: true },
        { key: "pin", label: "PIN", fieldType: { type: "password" }, required: false },
      ],
    },
  ],
} as unknown as SettingsSchema;

/** The SSH Proxy group (#4867): no auth select, a user and a password (#4888). */
const notNone = { field: "proxyType", equals: "none", negate: true };
const PROXY: SettingsSchema = {
  groups: [
    {
      key: "connection",
      label: "Connection",
      fields: [
        { key: "host", label: "Host", fieldType: { type: "text" }, required: true },
        { key: "username", label: "Username", fieldType: { type: "text" }, required: false },
      ],
    },
    {
      key: "proxy",
      label: "Proxy",
      fields: [
        {
          key: "proxyType",
          label: "Proxy Type",
          fieldType: {
            type: "select",
            options: [
              { value: "none", label: "None (direct)" },
              { value: "socks5", label: "SOCKS5" },
              { value: "socks4", label: "SOCKS4 / SOCKS4a" },
              { value: "http", label: "HTTP (CONNECT)" },
            ],
          },
          required: false,
          default: "none",
        },
        {
          key: "proxyHost",
          label: "Proxy Host",
          fieldType: { type: "text" },
          required: false,
          visibleWhen: notNone,
        },
        {
          key: "proxyUsername",
          label: "Proxy User",
          fieldType: { type: "text" },
          required: false,
          visibleWhen: notNone,
        },
        {
          key: "proxyPassword",
          label: "Proxy Password",
          fieldType: { type: "password" },
          required: false,
          visibleWhen: {
            ...notNone,
            allOf: [{ field: "proxyType", equals: "socks4", negate: true }],
          },
        },
      ],
    },
  ],
} as unknown as SettingsSchema;

const VIA_PROXY = {
  host: "server",
  username: "me",
  proxyType: "socks5",
  proxyHost: "proxy.corp",
  proxyUsername: "alice",
};

const TUNNEL = {
  host: "desk",
  username: "me",
  useSshTunnel: true,
  sshHost: "gw",
  sshUsername: "ops",
  sshAuthMethod: "password",
};

/**
 * The shared SSH Tunnel group with its proxy rows (#4887): one group holding
 * both the gateway's auth select + password and the proxy's user + password.
 */
const tunnelOn = { field: "useSshTunnel", equals: true };
const tunnelProxyChosen = {
  field: "sshProxyType",
  equals: "none",
  negate: true,
  allOf: [tunnelOn],
};
const VNC_TUNNEL_PROXY: SettingsSchema = {
  groups: [
    VNC.groups[0],
    {
      key: "sshTunnel",
      label: "SSH Tunnel",
      fields: [
        ...VNC.groups[1].fields,
        {
          key: "sshProxyType",
          label: "Proxy Type",
          fieldType: {
            type: "select",
            options: [
              { value: "none", label: "None (direct)" },
              { value: "socks5", label: "SOCKS5" },
              { value: "socks4", label: "SOCKS4 / SOCKS4a" },
              { value: "http", label: "HTTP (CONNECT)" },
            ],
          },
          required: false,
          default: "none",
          visibleWhen: tunnelOn,
        },
        {
          key: "sshProxyHost",
          label: "Proxy Host",
          fieldType: { type: "text" },
          required: false,
          visibleWhen: tunnelProxyChosen,
        },
        {
          key: "sshProxyUsername",
          label: "Proxy User",
          fieldType: { type: "text" },
          required: false,
          visibleWhen: tunnelProxyChosen,
        },
        {
          key: "sshProxyPassword",
          label: "Proxy Password",
          fieldType: { type: "password" },
          required: false,
          visibleWhen: {
            ...tunnelProxyChosen,
            allOf: [tunnelOn, { field: "sshProxyType", equals: "socks4", negate: true }],
          },
        },
      ],
    },
  ],
} as unknown as SettingsSchema;

function setStore(mode: "none" | "master_password" | "os_keychain", status: string) {
  useAppStore.setState({
    credentialStoreStatus: { mode, status } as never,
  });
}

describe("neededFieldSecrets", () => {
  it("needs a visible, empty tunnel password under password auth", () => {
    expect(neededFieldSecrets(VNC, TUNNEL)).toEqual([
      { kind: "field", key: "sshPassword", label: "SSH Password" },
    ]);
  });

  it("does not need it for key auth, a disabled tunnel or a typed value", () => {
    expect(neededFieldSecrets(VNC, { ...TUNNEL, sshAuthMethod: "key" })).toEqual([]);
    expect(neededFieldSecrets(VNC, { ...TUNNEL, useSshTunnel: false })).toEqual([]);
    expect(neededFieldSecrets(VNC, { ...TUNNEL, sshPassword: "typed" })).toEqual([]);
  });

  it("needs the proxy password when a SOCKS5 or HTTP proxy has a user (#4888)", () => {
    const slot = { kind: "field", key: "proxyPassword", label: "Proxy Password" };
    expect(neededFieldSecrets(PROXY, VIA_PROXY)).toEqual([slot]);
    expect(neededFieldSecrets(PROXY, { ...VIA_PROXY, proxyType: "http" })).toEqual([slot]);
  });

  it("does not need the proxy password without a user, a proxy, or for SOCKS4", () => {
    expect(neededFieldSecrets(PROXY, { ...VIA_PROXY, proxyUsername: "" })).toEqual([]);
    expect(neededFieldSecrets(PROXY, { ...VIA_PROXY, proxyUsername: "  " })).toEqual([]);
    expect(neededFieldSecrets(PROXY, { ...VIA_PROXY, proxyType: "none" })).toEqual([]);
    expect(neededFieldSecrets(PROXY, { ...VIA_PROXY, proxyType: "socks4" })).toEqual([]);
    expect(neededFieldSecrets(PROXY, { ...VIA_PROXY, proxyPassword: "typed" })).toEqual([]);
  });

  it("keeps the auth select in charge where a group has one", () => {
    // The tunnel user is set, but key auth means no password is needed.
    expect(neededFieldSecrets(VNC, { ...TUNNEL, sshAuthMethod: "key" })).toEqual([]);
  });

  describe("the SSH Tunnel group's proxy password (#4887)", () => {
    const proxySlot = { kind: "field", key: "sshProxyPassword", label: "Proxy Password" };
    const sshSlot = { kind: "field", key: "sshPassword", label: "SSH Password" };
    const viaProxy = {
      ...TUNNEL,
      sshProxyType: "socks5",
      sshProxyHost: "proxy.corp",
      sshProxyUsername: "alice",
    };

    it("follows the proxy user, not the gateway's auth select", () => {
      expect(neededFieldSecrets(VNC_TUNNEL_PROXY, viaProxy)).toEqual([sshSlot, proxySlot]);
      // Key auth needs no gateway password, but the proxy user still needs one.
      expect(neededFieldSecrets(VNC_TUNNEL_PROXY, { ...viaProxy, sshAuthMethod: "key" })).toEqual([
        proxySlot,
      ]);
    });

    it("is not needed without a proxy user, a proxy, a tunnel, or for SOCKS4", () => {
      const without = (over: Record<string, unknown>) =>
        neededFieldSecrets(VNC_TUNNEL_PROXY, { ...viaProxy, ...over });
      expect(without({ sshProxyUsername: "" })).toEqual([sshSlot]);
      expect(without({ sshProxyType: "none" })).toEqual([sshSlot]);
      expect(without({ sshProxyType: "socks4" })).toEqual([sshSlot]);
      expect(without({ sshProxyPassword: "typed" })).toEqual([sshSlot]);
      expect(without({ useSshTunnel: false })).toEqual([]);
    });

    it("keeps the gateway password under the auth select", () => {
      expect(neededFieldSecrets(VNC_TUNNEL_PROXY, TUNNEL)).toEqual([sshSlot]);
      expect(neededFieldSecrets(VNC_TUNNEL_PROXY, { ...TUNNEL, sshAuthMethod: "key" })).toEqual([]);
    });
  });

  it("needs a required plugin secret but not an optional one", () => {
    expect(neededFieldSecrets(PLUGIN, {})).toEqual([
      { kind: "field", key: "apiToken", label: "API Token" },
    ]);
  });

  it("needs the password of an inline password-auth hop only", () => {
    const settings = {
      proxyJump: [
        { host: "bastion", username: "ops", authMethod: "password" },
        { host: "k", username: "ops", authMethod: "key" },
        { connectionId: "saved", authMethod: "password" },
        { host: "typed", authMethod: "password", password: "x" },
      ],
    };
    expect(neededFieldSecrets(undefined, settings)).toEqual([
      { kind: "hop", id: "ops@bastion:22", host: "bastion", username: "ops" },
    ]);
  });

  it("identifies hops as user@host:port", () => {
    expect(hopIdentity({ host: "b", username: "u", port: 2222 })).toBe("u@b:2222");
    expect(hopIdentity({ connectionId: "x", host: "b" })).toBeNull();
  });
});

describe("hasFieldSecretsToSave", () => {
  it("is true only for a typed non-password secret", () => {
    expect(hasFieldSecretsToSave(VNC, { ...TUNNEL, sshPassword: "s" })).toBe(true);
    expect(hasFieldSecretsToSave(VNC, { ...TUNNEL, password: "p" })).toBe(false);
    expect(hasFieldSecretsToSave(undefined, { proxyJump: [{ host: "b", password: "x" }] })).toBe(
      true
    );
    expect(hasFieldSecretsToSave(VNC, TUNNEL)).toBe(false);
  });
});

describe("resolveFieldSecrets", () => {
  let requestPassword: ReturnType<typeof vi.fn<ResolveFieldSecretsOptions["requestPassword"]>>;
  let requestUnlock: ReturnType<typeof vi.fn<() => Promise<boolean>>>;

  beforeEach(() => {
    vi.clearAllMocks();
    requestPassword = vi.fn<ResolveFieldSecretsOptions["requestPassword"]>();
    requestUnlock = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    useAppStore.setState({ requestUnlock } as never);
    mockedResolve.mockResolvedValue({});
    mockedStore.mockResolvedValue(undefined);
  });

  const opts = (over: Partial<ResolveFieldSecretsOptions> = {}): ResolveFieldSecretsOptions => ({
    schema: VNC,
    settings: TUNNEL,
    connectionId: "Desk",
    sourceFile: null,
    requestPassword,
    ...over,
  });

  it("uses stored secrets without prompting", async () => {
    setStore("os_keychain", "unlocked");
    mockedResolve.mockResolvedValue({ fields: { sshPassword: "stored" } });
    const r = await resolveFieldSecrets(opts());
    expect(r).toEqual({ status: "resolved", settings: { ...TUNNEL, sshPassword: "stored" } });
    expect(requestPassword).not.toHaveBeenCalled();
  });

  it("in none mode prompts without a Save box, never touches the store, and connects", async () => {
    setStore("none", "unavailable");
    requestPassword.mockResolvedValue({ password: "entered", shouldSave: false });
    const r = await resolveFieldSecrets(opts());
    expect(r).toEqual({ status: "resolved", settings: { ...TUNNEL, sshPassword: "entered" } });
    expect(requestPassword).toHaveBeenCalledWith(
      "gw",
      "ops",
      expect.stringContaining("SSH Password"),
      "password",
      { allowSave: false }
    );
    expect(mockedResolve).not.toHaveBeenCalled();
    expect(mockedStore).not.toHaveBeenCalled();
  });

  it("prompts for a missing proxy password with the proxy's host and user and saves it", async () => {
    setStore("os_keychain", "unlocked");
    requestPassword.mockResolvedValue({ password: "proxy-pw", shouldSave: true });
    const r = await resolveFieldSecrets(opts({ schema: PROXY, settings: VIA_PROXY }));
    expect(r).toEqual({
      status: "resolved",
      settings: { ...VIA_PROXY, proxyPassword: "proxy-pw" },
    });
    expect(requestPassword).toHaveBeenCalledWith(
      "proxy.corp",
      "alice",
      expect.stringContaining("Proxy Password"),
      "password",
      { allowSave: true }
    );
    expect(mockedStore).toHaveBeenCalledWith(
      "Desk",
      { fields: { proxyPassword: "proxy-pw" } },
      null
    );
  });

  it("prompts for the tunnel proxy password with the proxy's host and user (#4887)", async () => {
    setStore("none", "unavailable");
    requestPassword.mockResolvedValue({ password: "proxy-pw", shouldSave: false });
    const settings = {
      ...TUNNEL,
      sshAuthMethod: "agent",
      sshProxyType: "http",
      sshProxyHost: "tunnel-proxy.corp",
      sshProxyUsername: "bob",
    };
    const r = await resolveFieldSecrets(opts({ schema: VNC_TUNNEL_PROXY, settings }));
    expect(r).toEqual({
      status: "resolved",
      settings: { ...settings, sshProxyPassword: "proxy-pw" },
    });
    expect(requestPassword).toHaveBeenCalledTimes(1);
    expect(requestPassword).toHaveBeenCalledWith(
      "tunnel-proxy.corp",
      "bob",
      expect.stringContaining("Proxy Password"),
      "password",
      { allowSave: false }
    );
  });

  it("uses a stored proxy password without prompting", async () => {
    setStore("os_keychain", "unlocked");
    mockedResolve.mockResolvedValue({ fields: { proxyPassword: "stored" } });
    const r = await resolveFieldSecrets(opts({ schema: PROXY, settings: VIA_PROXY }));
    expect(r).toEqual({ status: "resolved", settings: { ...VIA_PROXY, proxyPassword: "stored" } });
    expect(requestPassword).not.toHaveBeenCalled();
  });

  it("with a locked store asks to unlock first, then uses the stored secret", async () => {
    setStore("master_password", "locked");
    mockedResolve.mockResolvedValue({ fields: { sshPassword: "stored" } });
    const r = await resolveFieldSecrets(opts());
    expect(requestUnlock).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ status: "resolved", settings: { ...TUNNEL, sshPassword: "stored" } });
  });

  it("a dismissed unlock cancels with a clear message", async () => {
    setStore("master_password", "locked");
    requestUnlock.mockResolvedValue(false);
    const r = await resolveFieldSecrets(opts());
    expect(r.status).toBe("canceled");
    expect(r.status === "canceled" && r.reason).toMatch(/credential store/i);
    expect(mockedResolve).not.toHaveBeenCalled();
  });

  it("cancelling the prompt fails cleanly with a message naming the secret", async () => {
    setStore("os_keychain", "unlocked");
    requestPassword.mockResolvedValue(null);
    const r = await resolveFieldSecrets(opts());
    expect(r).toEqual({
      status: "canceled",
      reason: "Connect canceled — SSH Password is required.",
    });
    expect(mockedStore).not.toHaveBeenCalled();
  });

  it("saves a prompted secret when the Save box is checked", async () => {
    setStore("os_keychain", "unlocked");
    requestPassword.mockResolvedValue({ password: "entered", shouldSave: true });
    await resolveFieldSecrets(opts());
    expect(mockedStore).toHaveBeenCalledWith("Desk", { fields: { sshPassword: "entered" } }, null);
  });

  it("saves only the prompts whose own Save box was checked (#4474)", async () => {
    setStore("os_keychain", "unlocked");
    mockedResolve.mockResolvedValue(null);
    requestPassword
      .mockResolvedValueOnce({ password: "field-pw", shouldSave: false })
      .mockResolvedValueOnce({ password: "hop-pw", shouldSave: true });
    const settings = {
      ...TUNNEL,
      proxyJump: [{ host: "b", username: "ops", authMethod: "password" }],
    };
    await resolveFieldSecrets(opts({ settings }));
    expect(requestPassword).toHaveBeenCalledTimes(2);
    expect(mockedStore).toHaveBeenCalledWith("Desk", { hops: { "ops@b:22": "hop-pw" } }, null);
  });

  it("names the connection in every prompt when given a label (#4475)", async () => {
    setStore("os_keychain", "unlocked");
    mockedResolve.mockResolvedValue(null);
    requestPassword.mockResolvedValue({ password: "entered", shouldSave: false });
    await resolveFieldSecrets(opts({ label: "Desk" }));
    expect(requestPassword.mock.calls[0][4]).toEqual({ allowSave: true, label: "Desk" });
  });

  it("prompts for and splices an inline hop password", async () => {
    setStore("os_keychain", "unlocked");
    requestPassword.mockResolvedValue({ password: "hop-pw", shouldSave: false });
    const settings = {
      host: "t",
      proxyJump: [{ host: "b", username: "ops", authMethod: "password" }],
    };
    const r = await resolveFieldSecrets(opts({ schema: undefined, settings }));
    expect(r.status === "resolved" && r.settings.proxyJump).toEqual([
      { host: "b", username: "ops", authMethod: "password", password: "hop-pw" },
    ]);
    expect(requestPassword.mock.calls[0][0]).toBe("b");
  });

  it("without a saved id (create flow) prompts directly and offers no Save box", async () => {
    setStore("os_keychain", "unlocked");
    requestPassword.mockResolvedValue({ password: "entered", shouldSave: false });
    await resolveFieldSecrets(opts({ connectionId: null }));
    expect(mockedResolve).not.toHaveBeenCalled();
    expect(requestPassword.mock.calls[0][4]).toEqual({ allowSave: false });
  });

  it("unattended never prompts: a missing secret is refused", async () => {
    setStore("os_keychain", "unlocked");
    const r = await resolveFieldSecrets(opts({ unattended: true }));
    expect(r.status).toBe("refused");
    expect(requestPassword).not.toHaveBeenCalled();
  });

  it("unattended with a locked store is refused without asking to unlock", async () => {
    setStore("master_password", "locked");
    const r = await resolveFieldSecrets(opts({ unattended: true }));
    expect(r.status).toBe("refused");
    expect(requestUnlock).not.toHaveBeenCalled();
  });

  describe("a failed stored-secret read (#4520)", () => {
    let entries: LogEntry[];
    let unsubscribe: () => void;
    beforeEach(() => {
      entries = [];
      unsubscribe = onFrontendLog((e) => entries.push(e));
      mockedResolve.mockRejectedValue(new Error("keychain unavailable"));
    });
    afterEach(() => unsubscribe());

    it("logs a WARN and still prompts, saying the saved secret could not be read", async () => {
      setStore("os_keychain", "unlocked");
      requestPassword.mockResolvedValue({ password: "entered", shouldSave: false });
      const r = await resolveFieldSecrets(opts());
      expect(r).toEqual({ status: "resolved", settings: { ...TUNNEL, sshPassword: "entered" } });
      const warn = entries.find((e) => e.level === "WARN");
      expect(warn?.message).toContain("Failed to read stored field secrets for Desk");
      expect(warn?.message).toContain("keychain unavailable");
      expect(requestPassword.mock.calls[0][2]).toMatch(/could not be read/);
    });

    it("unattended, refuses with a read-failure reason instead of 'No saved'", async () => {
      setStore("os_keychain", "unlocked");
      const r = await resolveFieldSecrets(opts({ unattended: true }));
      expect(r).toEqual({ status: "refused", reason: "The saved SSH Password could not be read." });
      expect(entries.some((e) => e.level === "WARN")).toBe(true);
    });

    it("an empty store (no read failure) keeps the plain prompt", async () => {
      setStore("os_keychain", "unlocked");
      mockedResolve.mockResolvedValue(null);
      requestPassword.mockResolvedValue({ password: "entered", shouldSave: false });
      await resolveFieldSecrets(opts());
      expect(requestPassword.mock.calls[0][2]).toBe("Enter the SSH Password for this connection.");
      expect(entries.some((e) => e.level === "WARN")).toBe(false);
    });
  });

  it("does nothing when no field secret is needed", async () => {
    setStore("master_password", "locked");
    const r = await resolveFieldSecrets(opts({ settings: { host: "desk" } }));
    expect(r).toEqual({ status: "resolved", settings: { host: "desk" } });
    expect(requestUnlock).not.toHaveBeenCalled();
  });
});
