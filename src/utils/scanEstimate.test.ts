import { describe, it, expect } from "vitest";
import { countPorts, countHosts, estimateScanProbes } from "./scanEstimate";

describe("countPorts", () => {
  it("counts individual comma-separated ports", () => {
    expect(countPorts("22,80,443")).toBe(3);
    expect(countPorts("22")).toBe(1);
  });

  it("expands inclusive ranges", () => {
    expect(countPorts("8080-8090")).toBe(11);
    expect(countPorts("1-1024")).toBe(1024);
  });

  it("combines singles and ranges", () => {
    expect(countPorts("22,80,443,8080-8090")).toBe(3 + 11);
  });

  it("ignores blank segments", () => {
    expect(countPorts("22, ,80")).toBe(2);
    expect(countPorts("")).toBe(0);
  });
});

describe("countHosts", () => {
  it("counts a single plain host as one", () => {
    expect(countHosts("192.168.1.1")).toBe(1);
    expect(countHosts("example.com")).toBe(1);
  });

  it("expands a CIDR block to its address count", () => {
    expect(countHosts("10.0.0.0/24")).toBe(256);
    expect(countHosts("10.0.0.0/32")).toBe(1);
    expect(countHosts("10.0.0.0/16")).toBe(65536);
  });

  it("sums a comma-separated mix of hosts and CIDR blocks", () => {
    expect(countHosts("192.168.1.1, 10.0.0.0/24, example.com")).toBe(1 + 256 + 1);
  });

  it("treats an out-of-range or malformed prefix as a single host", () => {
    expect(countHosts("10.0.0.0/33")).toBe(1);
    expect(countHosts("10.0.0.0/abc")).toBe(1);
  });

  it("returns zero for empty input", () => {
    expect(countHosts("")).toBe(0);
  });
});

describe("estimateScanProbes", () => {
  it("multiplies host count by port count", () => {
    // 256 hosts * 5 ports
    expect(estimateScanProbes("10.0.0.0/24", "22,80,443,8080,8443")).toBe(256 * 5);
  });

  it("factors a CIDR block into the estimate (single-host would be under the warning threshold)", () => {
    // A single host across 100 ports is 100 probes (below 1000), but a /24
    // across the same ports is 25600 — the CIDR host-count must be factored in.
    expect(estimateScanProbes("192.168.1.1", "1-100")).toBe(100);
    expect(estimateScanProbes("192.168.1.0/24", "1-100")).toBe(256 * 100);
  });
});
