import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, dirname, relative, sep } from "path";
import { fileURLToPath } from "url";

/**
 * Takeover audit (#3395, SM-003 single-attach — maintainer decision
 * 2026-09-26): taking over another desktop's session must always be explicit.
 * The frontend may reach the backend's takeover attach only through the two
 * explicit, user-initiated actions — the evicted tab's **Reclaim** button and
 * the **confirmed** "Take over" in Running Sessions. Every implicit path
 * (re-open, restore, reconnect) uses a plain attach.
 */

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every non-test `.ts`/`.tsx` source file under `dir`. */
function productionSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...productionSources(full));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Source-relative (posix) paths of the files whose content matches `pattern`. */
function filesMatching(pattern: RegExp): string[] {
  return productionSources(SRC_DIR)
    .filter((file) => pattern.test(readFileSync(file, "utf8")))
    .map((file) => relative(SRC_DIR, file).split(sep).join("/"))
    .sort();
}

describe("takeover attach is only reachable from explicit user actions (#3395)", () => {
  it("invokes the takeover commands only from the API layer", () => {
    expect(filesMatching(/["'](reclaim_session|take_over_agent_session)["']/)).toEqual([
      "services/api.ts",
    ]);
  });

  it("never sends a takeover flag directly", () => {
    expect(filesMatching(/takeover\s*:\s*true/)).toEqual([]);
  });

  it("calls the Take over API only from the confirmed Running Sessions action", () => {
    expect(filesMatching(/takeOverAgentSession\s*\(/)).toEqual([
      "components/Sidebar/AgentRunningSessionsDialog.tsx",
      "services/api.ts",
    ]);
    const dialog = readFileSync(
      join(SRC_DIR, "components/Sidebar/AgentRunningSessionsDialog.tsx"),
      "utf8"
    );
    const confirmHandler = dialog.slice(dialog.indexOf("const handleConfirmTakeOver"));
    expect(confirmHandler.indexOf("takeOverAgentSession(")).toBeGreaterThan(0);
    expect(confirmHandler.indexOf("takeOverAgentSession(")).toBeLessThan(
      confirmHandler.indexOf("let body")
    );
  });

  it("calls Reclaim only from the store action behind the evicted overlay's button", () => {
    expect(filesMatching(/apiReclaimSession\s*\(/)).toEqual(["store/appStore.ts"]);
    expect(filesMatching(/\breclaimSession\s*\(/)).toEqual([
      "components/Terminal/TerminalEvictedOverlay.tsx",
      "services/api.ts",
    ]);
  });
});
