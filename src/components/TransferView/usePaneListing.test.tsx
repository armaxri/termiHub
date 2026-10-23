/**
 * Transfer-view pane listing (PROD-007, #3558): a refresh while the first
 * listing is still in flight must not strand the pane on an empty path (#4910).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FileEntry } from "@/types/connection";

const api = vi.hoisted(() => ({
  getHomeDir: vi.fn(),
  localListDir: vi.fn(),
  sessionListFiles: vi.fn(),
}));
vi.mock("@/services/api", async () => {
  const actual = await vi.importActual<typeof import("@/services/api")>("@/services/api");
  return { ...actual, ...api };
});

import { usePaneListing, type PaneListing } from "./usePaneListing";

const HOME = "/home/testuser";
const ENTRY: FileEntry = {
  name: "pick-me.txt",
  path: `${HOME}/pick-me.txt`,
  isDirectory: false,
  size: 8,
  modified: "",
  permissions: null,
} as FileEntry;

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

let container: HTMLDivElement;
let root: Root;
let listing: PaneListing;

function Probe({ sessionId, initialPath }: { sessionId: string | null; initialPath?: string }) {
  listing = usePaneListing("remote", sessionId, initialPath);
  return null;
}

async function mount(sessionId: string | null, initialPath?: string) {
  await act(async () => {
    root.render(<Probe sessionId={sessionId} initialPath={initialPath} />);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("usePaneListing", () => {
  it("a refresh during the first listing joins it instead of listing an empty path (#4910)", async () => {
    const first = deferred<FileEntry[]>();
    api.sessionListFiles.mockImplementation((_s: string, p: string) =>
      p === HOME ? first.promise : Promise.reject(new Error("readdir failed: No such file"))
    );
    await mount("s2", HOME);
    expect(api.sessionListFiles).toHaveBeenLastCalledWith("s2", HOME);

    // The harness polls refresh faster than a slow first SFTP listing resolves.
    let refreshes: Promise<void>[] = [];
    act(() => {
      refreshes = [listing.refresh(), listing.refresh(), listing.refresh()];
    });
    await act(async () => {
      first.resolve([ENTRY]);
      await Promise.all(refreshes);
    });

    expect(api.sessionListFiles).toHaveBeenCalledTimes(1);
    expect(listing.path).toBe(HOME);
    expect(listing.entries.map((e) => e.name)).toEqual(["pick-me.txt"]);
    expect(listing.error).toBeNull();
  });

  it("retries the requested directory after the first listing failed", async () => {
    api.sessionListFiles.mockRejectedValueOnce(new Error("channel not ready"));
    await mount("s2", HOME);
    expect(listing.error).toBe("channel not ready");
    expect(listing.path).toBe("");

    api.sessionListFiles.mockResolvedValue([ENTRY]);
    await act(async () => {
      await listing.refresh();
    });

    expect(api.sessionListFiles).toHaveBeenLastCalledWith("s2", HOME);
    expect(listing.path).toBe(HOME);
    expect(listing.error).toBeNull();
  });

  it("refreshes the resolved directory, not the requested one", async () => {
    api.sessionListFiles.mockImplementation(async (_s: string, p: string) => {
      if (p === "/nope") throw new Error("readdir failed: No such file");
      return [ENTRY];
    });
    await mount("s2", HOME);
    await act(async () => {
      await listing.navigate("/nope");
    });
    expect(listing.error).toMatch(/No such file/);

    await act(async () => {
      await listing.refresh();
    });

    expect(api.sessionListFiles).toHaveBeenLastCalledWith("s2", HOME);
    expect(listing.path).toBe(HOME);
    expect(listing.error).toBeNull();
  });

  it("never lists an empty path", async () => {
    await mount(null);
    await act(async () => {
      await listing.refresh();
    });
    expect(api.sessionListFiles).not.toHaveBeenCalled();
  });
});
