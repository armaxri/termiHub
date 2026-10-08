import { describe, it, expect } from "vitest";
import type { PluginDenial, PluginSandboxView } from "@/store/pluginSandboxBridge";
import { DENIAL_TOAST_WINDOW_MS, DenialToastLimiter, describeDenial } from "./denialToastLimiter";

const nameOf = (id: string) => (id === "sniffer" ? "Serial Sniffer" : id);

function denial(atMs: number, overrides: Partial<PluginDenial> = {}): PluginDenial {
  return {
    operation: "open_connection",
    target: "10.0.0.12:502",
    reason: "permission",
    atMs,
    ...overrides,
  };
}

function view(denials: PluginDenial[]): PluginSandboxView {
  return {
    outOfProcess: true,
    plugins: { sniffer: { isolation: "full", enforced: [], missing: [], denials } },
  };
}

describe("DenialToastLimiter", () => {
  it("does not replay denials that predate the first view", () => {
    const limiter = new DenialToastLimiter();
    expect(limiter.observe(view([denial(1)]), 0, nameOf)).toEqual([]);
  });

  it("toasts a new denial with the concept's copy", () => {
    const limiter = new DenialToastLimiter();
    limiter.observe(view([]), 0, nameOf);
    const [toast] = limiter.observe(view([denial(10)]), 10, nameOf);
    expect(toast.title).toBe("Blocked a plugin request");
    expect(toast.description).toBe(
      '"Serial Sniffer" tried to connect to 10.0.0.12:502 but does not have the network permission. Details are in the Log Viewer.'
    );
  });

  it("shows at most one toast per plugin per window and folds the rest", () => {
    const limiter = new DenialToastLimiter();
    limiter.observe(view([]), 0, nameOf);
    expect(limiter.observe(view([denial(1)]), 1_000, nameOf)).toHaveLength(1);
    // Two more inside the window: no toast, folded.
    expect(limiter.observe(view([denial(1), denial(2)]), 2_000, nameOf)).toEqual([]);
    expect(limiter.observe(view([denial(1), denial(2), denial(3)]), 3_000, nameOf)).toEqual([]);
    expect(limiter.nextFlushAt()).toBe(1_000 + DENIAL_TOAST_WINDOW_MS);
    // The window closes: one summary of the folded denials.
    expect(limiter.flush(1_000 + DENIAL_TOAST_WINDOW_MS - 1, nameOf)).toEqual([]);
    const [summary] = limiter.flush(1_000 + DENIAL_TOAST_WINDOW_MS, nameOf);
    expect(summary.description).toContain('blocked 2 more requests from "Serial Sniffer"');
    expect(limiter.nextFlushAt()).toBeUndefined();
  });

  it("folds a burst that arrives in one view into 'and N more'", () => {
    const limiter = new DenialToastLimiter();
    limiter.observe(view([]), 0, nameOf);
    const [toast] = limiter.observe(view([denial(1), denial(2), denial(3)]), 5, nameOf);
    expect(toast.description).toContain("(and 2 more)");
  });

  it("toasts again once the window has passed", () => {
    const limiter = new DenialToastLimiter();
    limiter.observe(view([]), 0, nameOf);
    limiter.observe(view([denial(1)]), 0, nameOf);
    const toasts = limiter.observe(view([denial(1), denial(2)]), DENIAL_TOAST_WINDOW_MS, nameOf);
    expect(toasts).toHaveLength(1);
  });

  it("toasts a plugin that appears after the first view", () => {
    const limiter = new DenialToastLimiter();
    limiter.observe({ outOfProcess: true, plugins: {} }, 0, nameOf);
    expect(limiter.observe(view([denial(1)]), 1, nameOf)).toHaveLength(1);
  });
});

describe("describeDenial", () => {
  it("describes file, limit and system-call denials", () => {
    expect(describeDenial("P", denial(0, { operation: "read_file", target: "/etc/hosts" }))).toBe(
      '"P" tried to access /etc/hosts, which is outside the folders it may use.'
    );
    expect(describeDenial("P", denial(0, { reason: "resourceLimit" }))).toContain("limit");
    expect(
      describeDenial(
        "P",
        denial(0, { reason: "syscall", operation: "connect", target: "", count: 4 })
      )
    ).toBe('"P": blocked system call: connect (×4).');
  });
});
