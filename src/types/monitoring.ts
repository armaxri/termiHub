/** System statistics retrieved from a remote Linux host. */
export interface SystemStats {
  hostname: string;
  uptimeSeconds: number;
  loadAverage: [number, number, number];
  cpuUsagePercent: number;
  memoryTotalKb: number;
  memoryAvailableKb: number;
  memoryUsedPercent: number;
  diskTotalKb: number;
  diskUsedKb: number;
  diskUsedPercent: number;
  osInfo: string;
}
