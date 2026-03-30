import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

const mockedInvoke = vi.mocked(invoke);
const mockedListen = vi.mocked(listen);

import {
  networkPortScan,
  networkPortScanCancel,
  networkPingStart,
  networkPingStop,
  networkDnsLookup,
  networkOpenPorts,
  networkTraceroute,
  networkTracerouteCancel,
  networkWolSend,
  networkWolDevicesList,
  networkWolDeviceSave,
  networkWolDeviceDelete,
  networkHttpMonitorStart,
  networkHttpMonitorStop,
  networkHttpMonitorList,
  onScanResult,
  onScanComplete,
  onPingResult,
  onPingComplete,
  onTracerouteHop,
  onTracerouteComplete,
  onHttpMonitorCheck,
} from "./networkApi";

describe("networkApi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("port scanner", () => {
    it("networkPortScan returns task ID", async () => {
      mockedInvoke.mockResolvedValue("task-123");

      const result = await networkPortScan("192.168.1.1", "1-1024");

      expect(mockedInvoke).toHaveBeenCalledWith("network_port_scan", {
        host: "192.168.1.1",
        ports: "1-1024",
        timeoutMs: null,
        concurrency: null,
      });
      expect(result).toBe("task-123");
    });

    it("networkPortScan passes optional timeout and concurrency", async () => {
      mockedInvoke.mockResolvedValue("task-456");

      await networkPortScan("10.0.0.1", "80,443", 5000, 100);

      expect(mockedInvoke).toHaveBeenCalledWith("network_port_scan", {
        host: "10.0.0.1",
        ports: "80,443",
        timeoutMs: 5000,
        concurrency: 100,
      });
    });

    it("networkPortScanCancel invokes with taskId", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await networkPortScanCancel("task-123");

      expect(mockedInvoke).toHaveBeenCalledWith("network_port_scan_cancel", { taskId: "task-123" });
    });
  });

  describe("ping", () => {
    it("networkPingStart returns task ID", async () => {
      mockedInvoke.mockResolvedValue("ping-task-1");

      const result = await networkPingStart("8.8.8.8");

      expect(mockedInvoke).toHaveBeenCalledWith("network_ping_start", {
        host: "8.8.8.8",
        intervalMs: null,
        count: null,
      });
      expect(result).toBe("ping-task-1");
    });

    it("networkPingStart passes optional interval and count", async () => {
      mockedInvoke.mockResolvedValue("ping-task-2");

      await networkPingStart("1.1.1.1", 500, 10);

      expect(mockedInvoke).toHaveBeenCalledWith("network_ping_start", {
        host: "1.1.1.1",
        intervalMs: 500,
        count: 10,
      });
    });

    it("networkPingStop invokes with taskId", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await networkPingStop("ping-task-1");

      expect(mockedInvoke).toHaveBeenCalledWith("network_ping_stop", { taskId: "ping-task-1" });
    });
  });

  describe("DNS lookup", () => {
    it("networkDnsLookup invokes with hostname and record type", async () => {
      const result = { records: [{ value: "93.184.216.34", ttl: 3600 }] };
      mockedInvoke.mockResolvedValue(result);

      const dns = await networkDnsLookup("example.com", "A");

      expect(mockedInvoke).toHaveBeenCalledWith("network_dns_lookup", {
        hostname: "example.com",
        recordType: "A",
        server: null,
      });
      expect(dns).toEqual(result);
    });

    it("networkDnsLookup passes custom DNS server when provided", async () => {
      mockedInvoke.mockResolvedValue({ records: [] });

      await networkDnsLookup("example.com", "MX", "8.8.8.8");

      expect(mockedInvoke).toHaveBeenCalledWith("network_dns_lookup", {
        hostname: "example.com",
        recordType: "MX",
        server: "8.8.8.8",
      });
    });
  });

  describe("open ports", () => {
    it("networkOpenPorts returns listening ports", async () => {
      const ports = [{ port: 22, protocol: "tcp", process: "sshd", pid: 1234 }];
      mockedInvoke.mockResolvedValue(ports);

      const result = await networkOpenPorts();

      expect(mockedInvoke).toHaveBeenCalledWith("network_open_ports");
      expect(result).toEqual(ports);
    });
  });

  describe("traceroute", () => {
    it("networkTraceroute returns task ID", async () => {
      mockedInvoke.mockResolvedValue("trace-1");

      const result = await networkTraceroute("8.8.8.8");

      expect(mockedInvoke).toHaveBeenCalledWith("network_traceroute", {
        host: "8.8.8.8",
        maxHops: null,
      });
      expect(result).toBe("trace-1");
    });

    it("networkTraceroute passes optional maxHops", async () => {
      mockedInvoke.mockResolvedValue("trace-2");

      await networkTraceroute("1.1.1.1", 15);

      expect(mockedInvoke).toHaveBeenCalledWith("network_traceroute", {
        host: "1.1.1.1",
        maxHops: 15,
      });
    });

    it("networkTracerouteCancel invokes with taskId", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await networkTracerouteCancel("trace-1");

      expect(mockedInvoke).toHaveBeenCalledWith("network_traceroute_cancel", { taskId: "trace-1" });
    });
  });

  describe("Wake-on-LAN", () => {
    it("networkWolSend invokes with mac, broadcast, and port", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await networkWolSend("AA:BB:CC:DD:EE:FF", "255.255.255.255", 9);

      expect(mockedInvoke).toHaveBeenCalledWith("network_wol_send", {
        mac: "AA:BB:CC:DD:EE:FF",
        broadcast: "255.255.255.255",
        port: 9,
      });
    });

    it("networkWolDevicesList returns saved devices", async () => {
      const devices = [
        {
          id: "d-1",
          name: "Desktop",
          mac: "AA:BB:CC:DD:EE:FF",
          broadcast: "255.255.255.255",
          port: 9,
        },
      ];
      mockedInvoke.mockResolvedValue(devices);

      const result = await networkWolDevicesList();

      expect(mockedInvoke).toHaveBeenCalledWith("network_wol_devices_list");
      expect(result).toEqual(devices);
    });

    it("networkWolDeviceSave invokes with device", async () => {
      mockedInvoke.mockResolvedValue(undefined);
      const device = {
        id: "d-1",
        name: "Desktop",
        mac: "AA:BB:CC:DD:EE:FF",
        broadcast: "255.255.255.255",
        port: 9,
      };

      await networkWolDeviceSave(device as never);

      expect(mockedInvoke).toHaveBeenCalledWith("network_wol_device_save", { device });
    });

    it("networkWolDeviceDelete invokes with deviceId", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await networkWolDeviceDelete("d-1");

      expect(mockedInvoke).toHaveBeenCalledWith("network_wol_device_delete", { deviceId: "d-1" });
    });
  });

  describe("HTTP monitor", () => {
    it("networkHttpMonitorStart returns monitor ID", async () => {
      mockedInvoke.mockResolvedValue("monitor-1");

      const result = await networkHttpMonitorStart("https://example.com");

      expect(mockedInvoke).toHaveBeenCalledWith("network_http_monitor_start", {
        url: "https://example.com",
        intervalMs: null,
        method: null,
        expectedStatus: null,
        timeoutMs: null,
      });
      expect(result).toBe("monitor-1");
    });

    it("networkHttpMonitorStart passes all optional params", async () => {
      mockedInvoke.mockResolvedValue("monitor-2");

      await networkHttpMonitorStart("https://api.example.com/health", 30000, "GET", 200, 10000);

      expect(mockedInvoke).toHaveBeenCalledWith("network_http_monitor_start", {
        url: "https://api.example.com/health",
        intervalMs: 30000,
        method: "GET",
        expectedStatus: 200,
        timeoutMs: 10000,
      });
    });

    it("networkHttpMonitorStop invokes with monitorId", async () => {
      mockedInvoke.mockResolvedValue(undefined);

      await networkHttpMonitorStop("monitor-1");

      expect(mockedInvoke).toHaveBeenCalledWith("network_http_monitor_stop", {
        monitorId: "monitor-1",
      });
    });

    it("networkHttpMonitorList returns all monitors", async () => {
      const monitors = [
        { id: "monitor-1", url: "https://example.com", status: "ok", latencyMs: 42 },
      ];
      mockedInvoke.mockResolvedValue(monitors);

      const result = await networkHttpMonitorList();

      expect(mockedInvoke).toHaveBeenCalledWith("network_http_monitor_list");
      expect(result).toEqual(monitors);
    });
  });

  describe("event listeners", () => {
    beforeEach(() => {
      mockedListen.mockResolvedValue(vi.fn());
    });

    it("onScanResult registers listener on network-scan-result", async () => {
      const cb = vi.fn();
      await onScanResult(cb);

      expect(mockedListen).toHaveBeenCalledWith("network-scan-result", expect.any(Function));
    });

    it("onScanResult delivers payload to callback", async () => {
      let capturedHandler: ((e: unknown) => void) | undefined;
      mockedListen.mockImplementation((_event, handler) => {
        capturedHandler = handler as (e: unknown) => void;
        return Promise.resolve(vi.fn());
      });

      const cb = vi.fn();
      await onScanResult(cb);

      capturedHandler!({ payload: { taskId: "t-1", port: 80, status: "open" } });

      expect(cb).toHaveBeenCalledWith({ taskId: "t-1", port: 80, status: "open" });
    });

    it("onScanComplete registers listener on network-scan-complete", async () => {
      await onScanComplete(vi.fn());
      expect(mockedListen).toHaveBeenCalledWith("network-scan-complete", expect.any(Function));
    });

    it("onPingResult registers listener on network-ping-result", async () => {
      await onPingResult(vi.fn());
      expect(mockedListen).toHaveBeenCalledWith("network-ping-result", expect.any(Function));
    });

    it("onPingComplete registers listener on network-ping-complete", async () => {
      await onPingComplete(vi.fn());
      expect(mockedListen).toHaveBeenCalledWith("network-ping-complete", expect.any(Function));
    });

    it("onTracerouteHop registers listener on network-traceroute-hop", async () => {
      await onTracerouteHop(vi.fn());
      expect(mockedListen).toHaveBeenCalledWith("network-traceroute-hop", expect.any(Function));
    });

    it("onTracerouteComplete registers listener on network-traceroute-complete", async () => {
      await onTracerouteComplete(vi.fn());
      expect(mockedListen).toHaveBeenCalledWith(
        "network-traceroute-complete",
        expect.any(Function)
      );
    });

    it("onHttpMonitorCheck registers listener on network-http-monitor-check", async () => {
      await onHttpMonitorCheck(vi.fn());
      expect(mockedListen).toHaveBeenCalledWith("network-http-monitor-check", expect.any(Function));
    });
  });
});
