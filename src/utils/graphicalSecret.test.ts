/**
 * The stored-password lookup of a VNC/RDP connect (#4520): a failed credential
 * read falls back to the prompt, but leaves a Log Viewer trace and tells the
 * user why they are asked, instead of looking like "no saved password".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/api", () => ({
  resolveCredential: vi.fn(),
  storeCredential: vi.fn(() => Promise.resolve()),
}));

import { resolveCredential } from "@/services/api";
import { useAppStore } from "@/store/appStore";
import type { LogEntry } from "@/types/terminal";
import { onFrontendLog } from "@/utils/frontendLog";
import { resolveGraphicalSettings, type ResolveGraphicalSettingsOptions } from "./graphicalSecret";

const mockedResolve = vi.mocked(resolveCredential);
const SETTINGS = { host: "desk", port: 5901, username: "alice" };

describe("resolveGraphicalSettings — stored password lookup", () => {
  let entries: LogEntry[];
  let unsubscribe: () => void;
  let requestPassword: ReturnType<typeof vi.fn<ResolveGraphicalSettingsOptions["requestPassword"]>>;

  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      credentialStoreStatus: { mode: "os_keychain", status: "unlocked" },
      passwordPromptShouldSave: false,
    } as never);
    requestPassword = vi.fn<ResolveGraphicalSettingsOptions["requestPassword"]>();
    entries = [];
    unsubscribe = onFrontendLog((e) => entries.push(e));
  });

  afterEach(() => unsubscribe());

  const run = () =>
    resolveGraphicalSettings({
      credentialId: "vnc-1",
      sourceFile: null,
      settings: SETTINGS,
      requestPassword,
    });

  it("uses the stored password without prompting or logging", async () => {
    mockedResolve.mockResolvedValue("stored");
    const r = await run();
    expect(r).toEqual({ status: "resolved", settings: { ...SETTINGS, password: "stored" } });
    expect(requestPassword).not.toHaveBeenCalled();
    expect(entries.some((e) => e.level === "WARN")).toBe(false);
  });

  it("with no stored password, prompts with no notice", async () => {
    mockedResolve.mockResolvedValue(null);
    requestPassword.mockResolvedValue("typed");
    const r = await run();
    expect(r).toEqual({ status: "resolved", settings: { ...SETTINGS, password: "typed" } });
    expect(requestPassword).toHaveBeenCalledWith("desk", "alice", "", "password");
  });

  it("a failed read logs a WARN and prompts, saying the saved password could not be read", async () => {
    mockedResolve.mockRejectedValue({ code: "E", message: "keychain unavailable" });
    requestPassword.mockResolvedValue("typed");
    const r = await run();
    expect(r).toEqual({ status: "resolved", settings: { ...SETTINGS, password: "typed" } });
    const warn = entries.find((e) => e.level === "WARN");
    expect(warn?.message).toBe(
      "Failed to read the saved remote-desktop password: keychain unavailable"
    );
    expect(requestPassword.mock.calls[0][2]).toMatch(/could not be read/);
  });
});
