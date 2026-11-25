import { describe, expect, it } from "vitest";
import type { EmbeddedServerConfig, ServerType } from "@/types/embeddedServer";
import type { HostChoice } from "@/utils/hostChoice";
import {
  configOf,
  fileServerSchema,
  folderName,
  formOf,
  missingText,
  newForm,
  openWarning,
  ownAddresses,
  presetBind,
  savedSignIn,
  serverName,
  whoOf,
  withType,
  type FileServerForm,
} from "./fileServerForm";
import { validateWithZod } from "@/hooks/useZodEditorForm";

const EDGE: HostChoice = { kind: "agent", agentId: "edge" };
const form = (over: Partial<FileServerForm> = {}): FileServerForm => ({
  ...newForm("http"),
  rootDirectory: "/srv/docs",
  ...over,
});
const SAVED: EmbeddedServerConfig = {
  id: "s",
  name: "Docs",
  serverType: "ftp",
  rootDirectory: "/srv/docs",
  bindHost: "0.0.0.0",
  port: 2100,
  autoStart: true,
  readOnly: false,
  ftpAuth: { type: "credentials", username: "ann", password: "" },
  maxConcurrentSessions: 3,
  host: EDGE as EmbeddedServerConfig["host"],
};

describe("the safer defaults", () => {
  it.each([
    ["http", "127.0.0.1", 8080],
    ["ftp", "127.0.0.1", 2121],
    // A device is never this computer.
    ["tftp", "", 6969],
  ] as const)("a new %s server is only for this computer and to download", (type, bind, port) => {
    expect(newForm(type)).toMatchObject({
      serverType: type,
      bindHost: bind,
      port,
      readOnly: true,
      signIn: false,
      autoStart: false,
      host: { kind: "thisComputer" },
    });
  });

  it("a saved server keeps what it has", () => {
    expect(formOf(SAVED)).toEqual({
      serverType: "ftp",
      rootDirectory: "/srv/docs",
      bindHost: "0.0.0.0",
      port: 2100,
      readOnly: false,
      directoryListing: true,
      signIn: true,
      username: "ann",
      password: "",
      name: "Docs",
      description: "",
      autoStart: true,
      host: EDGE,
    });
    expect(formOf({ ...SAVED, bindHost: " " }).bindHost).toBe("127.0.0.1");
    expect(formOf({ ...SAVED, ftpAuth: { type: "anonymous" } }).signIn).toBe(false);
    const http = { ...SAVED, serverType: "http" as const, directoryListing: false };
    expect(formOf(http)).toMatchObject({ signIn: false, directoryListing: false });
    const asks = { ...http, httpAuth: { username: "web", password: "" } };
    expect(formOf(asks)).toMatchObject({ signIn: true, username: "web" });
  });
});

describe("what can be saved", () => {
  const wrong = (over: Partial<FileServerForm>, saved?: ServerType) =>
    validateWithZod(fileServerSchema(saved), form(over)).errors;

  it.each([
    [{}, {}],
    [{ rootDirectory: "  " }, { rootDirectory: "Choose the folder to share." }],
    [{ rootDirectory: "/" }, { name: "Name is required." }],
    [{ rootDirectory: "/", name: "Root" }, {}],
    [{ bindHost: "" }, { bindHost: "Choose who can open it." }],
    [{ port: "" as const }, { port: "Port is required." }],
    [{ signIn: true }, { username: "User name is required.", password: "Password is required." }],
    [{ signIn: true, username: "a", password: "b" }, {}],
    // TFTP has no sign-in.
    [{ serverType: "tftp" as const, signIn: true }, {}],
  ])("%j", (over, errors) => {
    expect(wrong(over)).toEqual(errors);
  });

  it("a blank password keeps the saved one, which is there for its kind only", () => {
    const asks = { signIn: true, username: "a" };
    expect(wrong(asks, "http")).toEqual({});
    expect(wrong(asks, "ftp")).toEqual({ password: "Password is required." });
    expect(savedSignIn(SAVED)).toBe("ftp");
    expect(savedSignIn({ ...SAVED, ftpAuth: { type: "anonymous" } })).toBeUndefined();
    expect(savedSignIn({ ...SAVED, serverType: "tftp" })).toBeUndefined();
    expect(savedSignIn(undefined)).toBeUndefined();
  });

  it("says what is missing, in the order of the form", () => {
    const all = {
      rootDirectory: "x",
      port: "x",
      bindHost: "x",
      username: "x",
      password: "x",
      name: "x",
    };
    expect(missingText(all)).toBe(
      "Still needed: the folder, the port, who can open it, a user name, a password, a name"
    );
    expect(missingText({ name: "x" })).toBe("Still needed: a name");
  });

  it.each([
    ["/srv/fw", "fw"],
    ["C:\\share\\Firmware files\\", "Firmware files"],
    ["/", undefined],
    ["", undefined],
  ])("the folder %j is called %j", (folder, name) => {
    expect(folderName(folder)).toBe(name);
    expect(serverName({ name: " ", rootDirectory: folder })).toBe(name ?? "");
    expect(serverName({ name: " Own ", rootDirectory: folder })).toBe("Own");
  });
});

describe("another kind", () => {
  it("takes its port and who can open it, unless they were chosen", () => {
    expect(withType(newForm("http"), "tftp", true)).toEqual({
      serverType: "tftp",
      port: 6969,
      bindHost: "",
    });
    expect(withType(newForm("tftp"), "ftp", true)).toEqual({
      serverType: "ftp",
      port: 2121,
      bindHost: "127.0.0.1",
    });
    expect(withType(form({ port: 9000, bindHost: "0.0.0.0" }), "tftp", true)).toEqual({
      serverType: "tftp",
    });
    expect(withType(form(), "tftp", false)).toEqual({ serverType: "tftp", port: 6969 });
    expect(presetBind("http")).toBe("127.0.0.1");
  });
});

describe("what is saved", () => {
  it("a web server only serves, and asks when it should", () => {
    const asks = form({ signIn: true, username: "a", password: "b", readOnly: false });
    expect(configOf(asks, "id", undefined, true)).toEqual({
      id: "id",
      name: "docs",
      description: undefined,
      serverType: "http",
      rootDirectory: "/srv/docs",
      bindHost: "127.0.0.1",
      port: 8080,
      autoStart: false,
      readOnly: true,
      directoryListing: true,
      httpAuth: { username: "a", password: "b" },
      ftpAuth: undefined,
      host: { kind: "thisComputer" },
    });
    expect(configOf({ ...asks, signIn: false }, "id", undefined, true).httpAuth).toBeUndefined();
  });

  it.each([
    ["ftp", true, { type: "credentials", username: "a", password: "b" }],
    ["ftp", false, { type: "anonymous" }],
    ["tftp", true, undefined],
  ] as const)("%s, asking: %s", (serverType, signIn, ftpAuth) => {
    const saved = configOf(
      form({ serverType, signIn, username: "a", password: "b", readOnly: false }),
      "id",
      undefined,
      true
    );
    expect(saved.ftpAuth).toEqual(ftpAuth);
    expect(saved.httpAuth).toBeUndefined();
    expect(saved.readOnly).toBe(false);
    expect(saved.directoryListing).toBeUndefined();
  });

  it("keeps what the editor does not know, and the stored host unless it moved", () => {
    const kept = configOf(formOf(SAVED), "s", SAVED, false);
    expect(kept.maxConcurrentSessions).toBe(3);
    expect(kept).not.toHaveProperty("host");
    const moved = configOf({ ...formOf(SAVED), host: { kind: "thisComputer" } }, "s", SAVED, true);
    expect(moved.host).toEqual({ kind: "thisComputer" });
    const unreadable = configOf(form({ host: { kind: "unreadable" } }), "s", SAVED, true);
    expect(unreadable).not.toHaveProperty("host");
  });
});

describe("who can open it", () => {
  it.each([
    ["", undefined],
    ["127.0.0.1", "here"],
    ["localhost", "here"],
    ["::1", "here"],
    ["0.0.0.0", "network"],
    ["::", "network"],
    ["192.168.1.20", "address"],
  ])("%j is %s", (bind, who) => {
    expect(whoOf(bind)).toBe(who);
  });

  it("offers the addresses that others may reach, and the saved one", () => {
    const interfaces = [
      { name: "Loopback", addr: "127.0.0.1" },
      { name: "All interfaces", addr: "0.0.0.0" },
      { name: "en0", addr: "192.168.1.20" },
    ];
    const en0 = { value: "192.168.1.20", label: "192.168.1.20 (en0)" };
    expect(ownAddresses(interfaces, "0.0.0.0")).toEqual([en0]);
    expect(ownAddresses(interfaces, "192.168.1.20")).toEqual([en0]);
    expect(ownAddresses(interfaces, "10.0.0.9")).toEqual([
      en0,
      { value: "10.0.0.9", label: "10.0.0.9" },
    ]);
  });
});

describe("the warning, whenever others can reach it", () => {
  const open = { bindHost: "0.0.0.0" };
  it.each<[Partial<FileServerForm>, string]>([
    [{}, ""],
    [{ bindHost: "" }, ""],
    [{ bindHost: "::1" }, ""],
    [
      open,
      "Anyone on your network can get these files. Nobody is asked for a password, and nothing is encrypted.",
    ],
    // A web server has no uploads, whatever is stored.
    [
      { ...open, readOnly: false },
      "Anyone on your network can get these files. Nobody is asked for a password, and nothing is encrypted.",
    ],
    [
      { ...open, signIn: true },
      "Anyone on your network can get these files. They need the password. Nothing is encrypted.",
    ],
    [
      { ...open, serverType: "ftp", readOnly: false },
      "Anyone on your network can get these files, change them and put files there. Nobody is asked for a password, and nothing is encrypted.",
    ],
    [
      { ...open, serverType: "ftp", readOnly: true, host: EDGE },
      "Anyone who reaches that machine can get these files. Nobody is asked for a password, and nothing is encrypted.",
    ],
    [
      { bindHost: "192.168.1.20", serverType: "tftp", signIn: true },
      "Anyone who reaches 192.168.1.20 can get these files. TFTP has no password, and nothing is encrypted.",
    ],
  ])("%j", (over, text) => {
    expect(openWarning(form(over)).join(" ")).toBe(text);
  });
});
