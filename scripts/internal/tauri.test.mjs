import { describe, expect, it } from "vitest";

import { applyDevPort } from "./tauri.mjs";

const configFor = (port) => JSON.stringify({ build: { devUrl: `http://localhost:${port}` } });

describe("applyDevPort", () => {
  it("merges the resolved devUrl into `tauri dev`", () => {
    // The #1588 fix: without this, tauri.conf.json's static
    // http://localhost:1420 wins and every checkout loads checkout 0's URL.
    expect(applyDevPort(["dev"], 1450)).toEqual(["dev", "--config", configFor(1450)]);
  });

  it("keeps the caller's own --config winning (scripts/dev.sh)", () => {
    // Tauri merges configs left to right, later wins — so dev.sh's --config,
    // which carries its CLI port override, must come after the injected one.
    const own = JSON.stringify({ build: { devUrl: "http://localhost:1499" } });
    expect(applyDevPort(["dev", "--config", own], 1450)).toEqual([
      "dev",
      "--config",
      configFor(1450),
      "--config",
      own,
    ]);
  });

  it("stays ahead of a `--` runner/app argument separator", () => {
    expect(applyDevPort(["dev", "--", "-q"], 1450)).toEqual([
      "dev",
      "--config",
      configFor(1450),
      "--",
      "-q",
    ]);
  });

  it("preserves other dev flags", () => {
    expect(applyDevPort(["dev", "--exit-on-panic", "-f", "custom"], 1450)).toEqual([
      "dev",
      "--config",
      configFor(1450),
      "--exit-on-panic",
      "-f",
      "custom",
    ]);
  });

  it("passes every other subcommand through untouched", () => {
    // CI runs `pnpm tauri build` — this must stay byte-for-byte identical.
    for (const args of [
      ["build"],
      ["build", "--no-bundle", "--target", "x86_64-unknown-linux-gnu"],
      ["build", "--debug"],
      ["info"],
      ["--help"],
      [],
    ]) {
      expect(applyDevPort(args, 1450)).toEqual(args);
    }
  });

  it("does not mutate the caller's array", () => {
    const args = ["dev"];
    applyDevPort(args, 1450);
    expect(args).toEqual(["dev"]);
  });
});
