import { describe, expect, it } from "vitest";
import { compareHosts, insertSortedByHost, sortByHost } from "./hostSort";

const sorted = (hosts: string[]) => [...hosts].sort(compareHosts);

describe("compareHosts", () => {
  it("orders IPv4 addresses numerically, octet by octet", () => {
    expect(sorted(["192.168.0.100", "192.168.0.10", "192.168.0.9"])).toEqual([
      "192.168.0.9",
      "192.168.0.10",
      "192.168.0.100",
    ]);
  });

  it("sorts the maintainer's reported sweep into address order", () => {
    expect(
      sorted([
        "192.168.0.1",
        "192.168.0.90",
        "192.168.0.102",
        "192.168.0.91",
        "192.168.0.253",
        "192.168.0.254",
        "192.168.0.239",
      ])
    ).toEqual([
      "192.168.0.1",
      "192.168.0.90",
      "192.168.0.91",
      "192.168.0.102",
      "192.168.0.239",
      "192.168.0.253",
      "192.168.0.254",
    ]);
  });

  it("compares earlier octets before later ones", () => {
    expect(sorted(["10.0.1.1", "10.0.0.255", "9.255.255.255", "10.0.0.2"])).toEqual([
      "9.255.255.255",
      "10.0.0.2",
      "10.0.0.255",
      "10.0.1.1",
    ]);
  });

  it("orders IPv6 addresses by value regardless of compressed notation", () => {
    expect(
      sorted(["2001:db8::10", "2001:db8::9", "2001:db8:0:0:0:0:0:1", "::1", "fe80::1"])
    ).toEqual(["::1", "2001:db8:0:0:0:0:0:1", "2001:db8::9", "2001:db8::10", "fe80::1"]);
  });

  it("accepts bracketed and zone-scoped IPv6 addresses", () => {
    expect(sorted(["fe80::2%en0", "[fe80::1]", "fe80::1%en1"])).toEqual([
      "[fe80::1]",
      "fe80::1%en1",
      "fe80::2%en0",
    ]);
  });

  it("puts IPv4 before IPv6 before hostnames", () => {
    expect(sorted(["router.lan", "::1", "10.0.0.1", "alpha", "2001:db8::1"])).toEqual([
      "10.0.0.1",
      "::1",
      "2001:db8::1",
      "alpha",
      "router.lan",
    ]);
  });

  it("orders hostnames case-insensitively with numeric runs compared as numbers", () => {
    expect(sorted(["host10", "Host9", "host100", "beta"])).toEqual([
      "beta",
      "Host9",
      "host10",
      "host100",
    ]);
  });

  it("returns 0 for the same address", () => {
    expect(compareHosts("192.168.0.1", "192.168.0.1")).toBe(0);
    expect(compareHosts("2001:db8::1", "2001:DB8:0::1")).toBe(0);
  });
});

describe("sortByHost", () => {
  it("returns a sorted copy and keeps arrival order among equal hosts", () => {
    const rows = [
      { host: "10.0.0.10", port: 443 },
      { host: "10.0.0.2", port: 80 },
      { host: "10.0.0.10", port: 22 },
    ];
    const out = sortByHost(rows, (r) => r.host);
    expect(out.map((r) => `${r.host}:${r.port}`)).toEqual([
      "10.0.0.2:80",
      "10.0.0.10:443",
      "10.0.0.10:22",
    ]);
    expect(rows[0].host).toBe("10.0.0.10");
  });

  it("applies a tie-breaker for equal hosts", () => {
    const rows = [
      { host: "10.0.0.1", port: 443 },
      { host: "10.0.0.1", port: 22 },
    ];
    const out = sortByHost(
      rows,
      (r) => r.host,
      (a, b) => a.port - b.port
    );
    expect(out.map((r) => r.port)).toEqual([22, 443]);
  });
});

describe("insertSortedByHost (streaming)", () => {
  it("keeps the list in address order as results stream in out of order", () => {
    const arrival = ["192.168.0.1", "192.168.0.90", "192.168.0.102", "192.168.0.91", "192.168.0.9"];
    let list: { host: string }[] = [];
    const snapshots: string[][] = [];
    for (const host of arrival) {
      list = insertSortedByHost(list, { host }, (r) => r.host);
      snapshots.push(list.map((r) => r.host));
    }
    expect(snapshots[2]).toEqual(["192.168.0.1", "192.168.0.90", "192.168.0.102"]);
    expect(snapshots[3]).toEqual(["192.168.0.1", "192.168.0.90", "192.168.0.91", "192.168.0.102"]);
    expect(list.map((r) => r.host)).toEqual([
      "192.168.0.1",
      "192.168.0.9",
      "192.168.0.90",
      "192.168.0.91",
      "192.168.0.102",
    ]);
  });

  it("does not mutate the previous list", () => {
    const prev = [{ host: "10.0.0.2" }];
    const next = insertSortedByHost(prev, { host: "10.0.0.1" }, (r) => r.host);
    expect(prev).toEqual([{ host: "10.0.0.2" }]);
    expect(next).not.toBe(prev);
  });

  it("matches a full sort for any arrival order, including equal hosts", () => {
    const rows = [
      { host: "10.0.0.3", port: 2 },
      { host: "::1", port: 1 },
      { host: "10.0.0.3", port: 1 },
      { host: "nas", port: 1 },
      { host: "10.0.0.20", port: 1 },
    ];
    let list: typeof rows = [];
    for (const r of rows) list = insertSortedByHost(list, r, (x) => x.host);
    expect(list).toEqual(sortByHost(rows, (x) => x.host));
  });
});
