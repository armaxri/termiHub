import { describe, it, expect } from "vitest";
import { suggestedSaveCopyPath } from "./saveCopyPath";

describe("suggestedSaveCopyPath", () => {
  it("places the file's basename in the remote home directory", () => {
    expect(suggestedSaveCopyPath("/etc/nginx/nginx.conf", "/home/alice")).toBe(
      "/home/alice/nginx.conf"
    );
  });

  it("normalizes a trailing slash on the home directory", () => {
    expect(suggestedSaveCopyPath("/etc/hosts", "/home/alice/")).toBe("/home/alice/hosts");
  });

  it("handles the root directory as home without doubling the slash", () => {
    expect(suggestedSaveCopyPath("/etc/hosts", "/")).toBe("/hosts");
  });

  it("falls back to a same-directory .copy sibling when home is unknown", () => {
    expect(suggestedSaveCopyPath("/etc/nginx/nginx.conf")).toBe("/etc/nginx/nginx.conf.copy");
    expect(suggestedSaveCopyPath("/etc/nginx/nginx.conf", null)).toBe(
      "/etc/nginx/nginx.conf.copy"
    );
    expect(suggestedSaveCopyPath("/etc/nginx/nginx.conf", "")).toBe("/etc/nginx/nginx.conf.copy");
    expect(suggestedSaveCopyPath("/etc/nginx/nginx.conf", "   ")).toBe(
      "/etc/nginx/nginx.conf.copy"
    );
  });

  it("never returns the original read-only path unchanged", () => {
    const original = "/etc/nginx/nginx.conf";
    expect(suggestedSaveCopyPath(original, "/home/alice")).not.toBe(original);
    expect(suggestedSaveCopyPath(original)).not.toBe(original);
  });

  it("keeps a file already in home from colliding with itself via the sibling fallback", () => {
    // Original lives in home: home-join yields the identical path, so we must
    // fall back to the .copy sibling rather than suggest the read-only original.
    expect(suggestedSaveCopyPath("/home/alice/notes.txt", "/home/alice")).toBe(
      "/home/alice/notes.txt.copy"
    );
  });
});
