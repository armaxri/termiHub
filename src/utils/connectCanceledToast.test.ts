import { describe, it, expect, vi, afterEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { toast } from "@/components/ui";
import { toastConnectCanceled } from "./connectCanceledToast";

type Call = [string, { testId: string; action: { label: string; onClick: () => void } }];

describe("toastConnectCanceled (#5838, #5881)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("names the connect as an info toast with Retry", () => {
    const info = vi.spyOn(toast, "info").mockImplementation(() => "id");
    const success = vi.spyOn(toast, "success");
    const retry = vi.fn();
    toastConnectCanceled("prod-db", "prompt", { retry, typePasswordInstead: vi.fn() });

    expect(success).not.toHaveBeenCalled();
    const [message, options] = info.mock.calls[0] as unknown as Call;
    expect(message).toBe('Connect to "prod-db" canceled.');
    expect(options.testId).toBe("connect-canceled-toast");
    expect(options.action.label).toBe("Retry");
    options.action.onClick();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("after a canceled unlock offers 'Type password instead'", () => {
    const info = vi.spyOn(toast, "info").mockImplementation(() => "id");
    const typePasswordInstead = vi.fn();
    toastConnectCanceled("prod-db", "unlock", { retry: vi.fn(), typePasswordInstead });

    const [message, options] = info.mock.calls[0] as unknown as Call;
    expect(message).toBe('Connect to "prod-db" canceled. Its saved password stays locked.');
    expect(options.action.label).toBe("Type password instead");
    options.action.onClick();
    expect(typePasswordInstead).toHaveBeenCalledTimes(1);
  });

  it("offers Retry after an unlock when the path cannot skip the store", () => {
    const info = vi.spyOn(toast, "info").mockImplementation(() => "id");
    toastConnectCanceled("desk", "unlock", { retry: vi.fn() });

    const [message, options] = info.mock.calls[0] as unknown as Call;
    expect(message).toBe('Connect to "desk" canceled.');
    expect(options.action.label).toBe("Retry");
  });
});

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry) ? [full] : [];
  });
}

describe("no bare connect-canceled toast (#5881)", () => {
  it("no toast in src/ reads exactly 'Connect canceled'", () => {
    const bare = /\btoast\.\w+\(\s*["'`]Connect canceled\.?["'`]/;
    const offenders = sourceFiles(SRC_DIR).filter((f) => bare.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
