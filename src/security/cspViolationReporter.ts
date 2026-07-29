/**
 * Content-Security-Policy violation reporter (#2059).
 *
 * The app ships a restrictive CSP (`tauri.conf.json` → `app.security.csp`).
 * CSP is only enforced in a **production** WebView build, never in `dev`, so a
 * CSP that blocks something the app legitimately needs — the class of
 * regression that nearly shipped in #2048 — is invisible until a real build is
 * driven. This installs a `securitypolicyviolation` listener that makes any
 * violation observable in two places:
 *
 * - the in-app **LogViewer** (via {@link frontendLog}), for a developer
 *   inspecting a running build, and
 * - a hidden DOM **sink** (`data-testid="csp-violations"`) whose `data-count`
 *   attribute the system-test bridge reads, so an automated boot/render check
 *   can assert **zero** violations under the shipped CSP (see
 *   `tests/system/tests/test_csp.py`).
 *
 * The listener only ever fires when the browser actually blocks a resource, so
 * it is inert on a healthy build and safe to install unconditionally.
 */

import { frontendLog } from "@/utils/frontendLog";

/** `data-testid` of the hidden element the test bridge reads violation state from. */
export const CSP_VIOLATION_SINK_TESTID = "csp-violations";

/** Guards against double-installation (React StrictMode / HMR re-entry). */
let installed = false;

/** Create (once) the hidden sink the bridge queries; returns the existing one if present. */
function ensureSink(doc: Document): HTMLElement {
  const existing = doc.querySelector<HTMLElement>(`[data-testid="${CSP_VIOLATION_SINK_TESTID}"]`);
  if (existing) return existing;
  const sink = doc.createElement("div");
  sink.setAttribute("data-testid", CSP_VIOLATION_SINK_TESTID);
  sink.setAttribute("data-count", "0");
  sink.hidden = true;
  (doc.body ?? doc.documentElement).appendChild(sink);
  return sink;
}

/**
 * Record one CSP violation into the sink: bump `data-count` and append a
 * `<directive> blocked <uri>` line to the sink's text, so a failing assertion
 * can report *what* was blocked, not merely that something was.
 */
function recordViolation(sink: HTMLElement, e: SecurityPolicyViolationEvent): void {
  const count = Number(sink.getAttribute("data-count") ?? "0") + 1;
  sink.setAttribute("data-count", String(count));
  const detail = `${e.violatedDirective} blocked ${e.blockedURI || "(inline)"}`;
  sink.textContent = `${sink.textContent ?? ""}${detail}\n`;
  frontendLog("csp", `violation: ${detail} (source ${e.sourceFile ?? "?"}:${e.lineNumber ?? 0})`);
}

/**
 * Install the CSP-violation reporter on the given document (defaults to the
 * global `document`). Idempotent — safe to call more than once. Returns the
 * hidden sink element so callers/tests can inspect it directly.
 */
export function installCspViolationReporter(doc: Document = document): HTMLElement {
  const sink = ensureSink(doc);
  if (installed) return sink;
  installed = true;
  doc.addEventListener("securitypolicyviolation", (e) => {
    recordViolation(sink, e as SecurityPolicyViolationEvent);
  });
  return sink;
}

/** Reset installation state (tests only). */
export function resetCspViolationReporterForTests(): void {
  installed = false;
}
