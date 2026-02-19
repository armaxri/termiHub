import { describe, it, expect } from "vitest";
import { parseHostPort } from "./parseHostPort";

describe("parseHostPort", () => {
  describe("IPv4 with port", () => {
    it("extracts port from IPv4:port", () => {
      expect(parseHostPort("192.168.0.2:2222")).toEqual({ host: "192.168.0.2", port: 2222 });
    });

    it("extracts standard SSH port", () => {
      expect(parseHostPort("10.0.0.1:22")).toEqual({ host: "10.0.0.1", port: 22 });
    });
  });

  describe("hostname with port", () => {
    it("extracts port from hostname:port", () => {
      expect(parseHostPort("myserver.com:8080")).toEqual({ host: "myserver.com", port: 8080 });
    });

    it("extracts port from simple hostname", () => {
      expect(parseHostPort("raspberrypi:2222")).toEqual({ host: "raspberrypi", port: 2222 });
    });
  });

  describe("IPv6 bracket notation with port", () => {
    it("extracts port from [::1]:port", () => {
      expect(parseHostPort("[::1]:2222")).toEqual({ host: "::1", port: 2222 });
    });

    it("extracts port from full IPv6 bracketed address", () => {
      expect(parseHostPort("[2001:db8::1]:443")).toEqual({ host: "2001:db8::1", port: 443 });
    });
  });

  describe("plain hosts (no port)", () => {
    it("returns null port for plain IPv4", () => {
      expect(parseHostPort("192.168.1.100")).toEqual({ host: "192.168.1.100", port: null });
    });

    it("returns null port for plain hostname", () => {
      expect(parseHostPort("myserver.com")).toEqual({ host: "myserver.com", port: null });
    });

    it("returns null port for simple hostname", () => {
      expect(parseHostPort("localhost")).toEqual({ host: "localhost", port: null });
    });
  });

  describe("bare IPv6 (no brackets, no split)", () => {
    it("does not split bare ::1", () => {
      expect(parseHostPort("::1")).toEqual({ host: "::1", port: null });
    });

    it("does not split full bare IPv6", () => {
      expect(parseHostPort("2001:db8::1")).toEqual({ host: "2001:db8::1", port: null });
    });

    it("does not split fe80::1", () => {
      expect(parseHostPort("fe80::1")).toEqual({ host: "fe80::1", port: null });
    });
  });

  describe("invalid port values", () => {
    it("rejects port 0", () => {
      expect(parseHostPort("host:0")).toEqual({ host: "host:0", port: null });
    });

    it("rejects port above 65535", () => {
      expect(parseHostPort("host:65536")).toEqual({ host: "host:65536", port: null });
    });

    it("rejects port 99999", () => {
      expect(parseHostPort("host:99999")).toEqual({ host: "host:99999", port: null });
    });

    it("rejects bracketed IPv6 with port 0", () => {
      expect(parseHostPort("[::1]:0")).toEqual({ host: "[::1]:0", port: null });
    });

    it("rejects bracketed IPv6 with port above 65535", () => {
      expect(parseHostPort("[::1]:70000")).toEqual({ host: "[::1]:70000", port: null });
    });
  });

  describe("edge cases", () => {
    it("trims whitespace", () => {
      expect(parseHostPort("  192.168.0.2:22  ")).toEqual({ host: "192.168.0.2", port: 22 });
    });

    it("handles empty string", () => {
      expect(parseHostPort("")).toEqual({ host: "", port: null });
    });

    it("handles port 1 (minimum valid)", () => {
      expect(parseHostPort("host:1")).toEqual({ host: "host", port: 1 });
    });

    it("handles port 65535 (maximum valid)", () => {
      expect(parseHostPort("host:65535")).toEqual({ host: "host", port: 65535 });
    });

    it("does not split on non-numeric port", () => {
      expect(parseHostPort("host:abc")).toEqual({ host: "host:abc", port: null });
    });

    it("does not split when port part is empty", () => {
      expect(parseHostPort("host:")).toEqual({ host: "host:", port: null });
    });
  });
});
