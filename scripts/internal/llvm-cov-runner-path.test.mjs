import { describe, it, expect } from "vitest";
import { cargoTargetDirectory, runnerPath } from "./llvm-cov-runner-path.mjs";

describe("runnerPath", () => {
  it("names the instrumented runner in the llvm-cov target dir", () => {
    expect(runnerPath("/w/termiHub/target", "linux")).toBe(
      "/w/termiHub/target/llvm-cov-target/debug/termihub-plugin-runner"
    );
    expect(runnerPath("/w/termiHub/target", "darwin")).toBe(
      "/w/termiHub/target/llvm-cov-target/debug/termihub-plugin-runner"
    );
  });

  it("adds the Windows executable suffix", () => {
    expect(runnerPath("D:\\a\\termiHub\\target", "win32")).toBe(
      "D:\\a\\termiHub\\target\\llvm-cov-target\\debug\\termihub-plugin-runner.exe"
    );
  });
});

describe("cargoTargetDirectory", () => {
  it("reads target_directory from cargo metadata", () => {
    expect(cargoTargetDirectory(JSON.stringify({ target_directory: "/x/target" }))).toBe(
      "/x/target"
    );
  });

  it("refuses metadata without a target directory", () => {
    expect(() => cargoTargetDirectory("{}")).toThrow(/target_directory/);
  });
});
