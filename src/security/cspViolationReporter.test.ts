import { beforeEach, describe, expect, it } from "vitest";
import { LogEntry } from "@/types/terminal";
import { onFrontendLog } from "@/utils/frontendLog";
import {
  CSP_VIOLATION_SINK_TESTID,
  installCspViolationReporter,
  resetCspViolationReporterForTests,
} from "./cspViolationReporter";

/** Dispatch a synthetic CSP violation on the document. */
function dispatchViolation(
  doc: Document,
  init: Partial<SecurityPolicyViolationEventInit> = {}
): void {
  const event = new Event("securitypolicyviolation") as SecurityPolicyViolationEvent;
  Object.assign(event, {
    violatedDirective: "script-src",
    blockedURI: "blob:",
    sourceFile: "app.js",
    lineNumber: 1,
    ...init,
  });
  doc.dispatchEvent(event);
}

function sink(doc: Document): HTMLElement | null {
  return doc.querySelector<HTMLElement>(`[data-testid="${CSP_VIOLATION_SINK_TESTID}"]`);
}

describe("cspViolationReporter", () => {
  beforeEach(() => {
    resetCspViolationReporterForTests();
    document.body.innerHTML = "";
  });

  it("installs a hidden sink starting at zero violations", () => {
    installCspViolationReporter(document);
    const el = sink(document);
    expect(el).not.toBeNull();
    expect(el!.hidden).toBe(true);
    expect(el!.getAttribute("data-count")).toBe("0");
  });

  it("records each violation into the sink with the blocked directive", () => {
    installCspViolationReporter(document);
    dispatchViolation(document, { violatedDirective: "connect-src", blockedURI: "ws://x" });
    dispatchViolation(document, { violatedDirective: "script-src", blockedURI: "blob:" });
    const el = sink(document)!;
    expect(el.getAttribute("data-count")).toBe("2");
    expect(el.textContent).toContain("connect-src blocked ws://x");
    expect(el.textContent).toContain("script-src blocked blob:");
  });

  it("is idempotent — a second install neither duplicates the sink nor double-counts", () => {
    installCspViolationReporter(document);
    installCspViolationReporter(document);
    dispatchViolation(document);
    expect(document.querySelectorAll(`[data-testid="${CSP_VIOLATION_SINK_TESTID}"]`)).toHaveLength(
      1
    );
    expect(sink(document)!.getAttribute("data-count")).toBe("1");
  });

  it("logs each violation at WARN so it reaches the durable log (#4933)", () => {
    installCspViolationReporter(document);
    const entries: LogEntry[] = [];
    // Subscribing flushes the startup buffer; only the dispatch below counts.
    const unsubscribe = onFrontendLog((entry) => entries.push(entry));
    entries.length = 0;
    dispatchViolation(document, { violatedDirective: "font-src", blockedURI: "data:warn-probe" });
    unsubscribe();
    const csp = entries.filter((e) => e.message.includes("font-src blocked data:warn-probe"));
    expect(csp.length).toBeGreaterThan(0);
    for (const entry of csp) {
      expect(entry.level).toBe("WARN");
      expect(entry.target).toBe("frontend::csp");
      expect(entry.message).toMatch(/^violation: /);
    }
  });
});
