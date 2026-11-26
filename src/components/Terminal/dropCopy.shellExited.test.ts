/**
 * A shell whose end comes with no status termiHub can trust (#5995): a Windows
 * SSH shell (Win32-OpenSSH reports exit status 0 for a PTY shell that ran
 * `exit 5`). It never reads as "exit code 0" or "ended normally", and it never
 * reconnects: the user ended it.
 */
import { describe, expect, it } from "vitest";
import type { TerminalTab } from "@/types/terminal";
import { dropMayReconnect } from "@/store/reconnectHelpers";
import {
  disconnectCauseLine,
  disconnectCauseOf,
  isLinkDrop,
  sessionEndNoticeFor,
  sessionEndSeparator,
} from "./dropCopy";

const AT = new Date(2026, 10, 26, 9, 5, 7);
const ENDED = { code: null, reason: "dropped" } as const;

describe("a shell that ended without a status it can trust (#5995)", () => {
  it("writes [Process exited] without a code, not a lost or closed link", () => {
    for (const transport of ["ssh", "agent"] as const) {
      expect(
        sessionEndSeparator({
          transport,
          exitCode: null,
          reason: "dropped",
          at: AT,
          endCause: "shell_exited",
        })
      ).toBe("[Process exited]");
    }
  });

  it("says the session ended, never normally and never with a code", () => {
    const cause = disconnectCauseOf({ transport: "ssh", exit: ENDED, endCause: "shell_exited" });
    expect(cause).toBe("shellEnded");
    expect(disconnectCauseLine(cause!)).toBe("The session ended.");
    expect(isLinkDrop(cause)).toBe(false);
    const notice = sessionEndNoticeFor(cause, { transport: "ssh", code: null });
    expect(notice.kind).toBe("ended");
    expect(notice.heading).toBe("Session ended");
    expect(notice.causeLine).toBe("The session ended.");
    expect(`${notice.heading} ${notice.causeLine}`).not.toMatch(/normally|code 0/);
  });

  it("is known also after the exit was cleared, from the end cause alone", () => {
    expect(disconnectCauseOf({ transport: "ssh", endCause: "shell_exited" })).toBe("shellEnded");
  });

  it("a user kill still reads as the user's", () => {
    expect(
      disconnectCauseOf({
        transport: "ssh",
        exit: { code: null, reason: "killed" },
        endCause: "shell_exited",
      })
    ).toBe("user");
  });

  it("never arms the reconnect, even on a resilient tab", () => {
    // An agent-hosted tab is always resilient (#2476).
    const tab = {
      id: "t",
      contentType: "terminal",
      connectionType: "ssh",
      config: { type: "ssh", config: { host: "win", agentId: "lab" } },
    } as unknown as TerminalTab;
    expect(dropMayReconnect(tab, null)).toBe(true);
    expect(dropMayReconnect(tab, "shell_exited")).toBe(false);
  });
});
