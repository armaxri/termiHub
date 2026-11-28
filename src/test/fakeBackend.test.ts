import { describe, it, expect } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { fakeBackend } from "./fakeBackend";
import { localReadFile, localStat } from "@/services/api";

/**
 * The typed fake backend (#6151): handlers are keyed by the generated command
 * names, receive the typed arguments and return the typed result. A command
 * without a handler fails the test.
 */
describe("fakeBackend", () => {
  it("answers each command from its handler with the arguments sent", async () => {
    const backend = fakeBackend({
      local_read_file: ({ path }) => `contents of ${path}`,
      local_stat: async ({ path }) => ({
        name: path,
        path,
        isDirectory: false,
        size: 3,
        modified: "",
        permissions: null,
        writable: null,
      }),
    });
    expect(await localReadFile("/a.txt")).toBe("contents of /a.txt");
    expect((await localStat("/b.txt")).size).toBe(3);
    expect(backend.calls).toEqual([
      { command: "local_read_file", args: { path: "/a.txt" } },
      { command: "local_stat", args: { path: "/b.txt" } },
    ]);
    expect(backend.callsTo("local_stat")).toEqual([{ path: "/b.txt" }]);
  });

  it("rejects an unhandled command and records it", async () => {
    const backend = fakeBackend({}, { strict: false });
    await expect(invoke("local_read_file", { path: "/x" })).rejects.toThrow(
      'fakeBackend: no handler for "local_read_file"'
    );
    expect(backend.unhandled).toEqual(["local_read_file"]);
  });

  it("lets a test replace handlers mid-way", async () => {
    const backend = fakeBackend({ local_read_file: () => "one" });
    expect(await localReadFile("/a")).toBe("one");
    backend.handle({ local_read_file: () => "two" });
    expect(await localReadFile("/a")).toBe("two");
  });

  it("forgets the calls so far on clearCalls, keeping the handlers", async () => {
    const backend = fakeBackend({ local_read_file: () => "one" });
    await localReadFile("/a");
    backend.clearCalls();
    expect(backend.calls).toEqual([]);
    expect(await localReadFile("/b")).toBe("one");
    expect(backend.callsTo("local_read_file")).toEqual([{ path: "/b" }]);
  });

  it("passes a handler's rejection through", async () => {
    fakeBackend({
      local_read_file: () => {
        throw new Error("permission denied");
      },
    });
    await expect(localReadFile("/a")).rejects.toThrow("permission denied");
  });

  it("does not compile with an unknown command or a wrong result type", () => {
    // @ts-expect-error -- not a command the frontend invokes
    fakeBackend({ no_such_command: () => undefined }, { strict: false });
    // @ts-expect-error -- local_read_file returns a string
    fakeBackend({ local_read_file: () => 42 }, { strict: false });
    // @ts-expect-error -- local_stat takes { path }, not { file }
    fakeBackend({ local_stat: ({ file }) => file }, { strict: false });
  });
});
