import { ConnectionFolder, SavedConnection, FileEntry } from "@/types/connection";

export const MOCK_FOLDERS: ConnectionFolder[] = [
  { id: "folder-1", name: "Development", parentId: null, isExpanded: true },
  { id: "folder-2", name: "Test Targets", parentId: null, isExpanded: false },
  { id: "folder-3", name: "Raspberry Pis", parentId: "folder-2", isExpanded: false },
];

export const MOCK_CONNECTIONS: SavedConnection[] = [
  {
    id: "conn-1",
    name: "Local Bash",
    folderId: "folder-1",
    config: { type: "local", config: { shellType: "bash" } },
  },
  {
    id: "conn-2",
    name: "Local Zsh",
    folderId: "folder-1",
    config: { type: "local", config: { shellType: "zsh" } },
  },
  {
    id: "conn-3",
    name: "Serial /dev/ttyUSB0",
    folderId: "folder-2",
    config: {
      type: "serial",
      config: {
        port: "/dev/ttyUSB0",
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: "none",
        flowControl: "none",
      },
    },
  },
  {
    id: "conn-4",
    name: "RPi Build Agent",
    folderId: "folder-3",
    config: {
      type: "ssh",
      config: {
        host: "192.168.1.100",
        port: 22,
        username: "pi",
        authMethod: "key",
        keyPath: "~/.ssh/id_rsa",
      },
    },
  },
  {
    id: "conn-5",
    name: "RPi Test Runner",
    folderId: "folder-3",
    config: {
      type: "ssh",
      config: {
        host: "192.168.1.101",
        port: 22,
        username: "pi",
        authMethod: "password",
      },
    },
  },
  {
    id: "conn-6",
    name: "Telnet Debug Port",
    folderId: null,
    config: {
      type: "telnet",
      config: { host: "192.168.1.200", port: 4000 },
    },
  },
];

export const MOCK_FILES: FileEntry[] = [
  { name: "Documents", path: "/home/pi/Documents", isDirectory: true, size: 4096, modified: "2026-02-01T10:00:00Z", permissions: null },
  { name: "projects", path: "/home/pi/projects", isDirectory: true, size: 4096, modified: "2026-02-05T14:30:00Z", permissions: null },
  { name: "scripts", path: "/home/pi/scripts", isDirectory: true, size: 4096, modified: "2026-01-20T08:00:00Z", permissions: null },
  { name: ".bashrc", path: "/home/pi/.bashrc", isDirectory: false, size: 3526, modified: "2026-01-15T12:00:00Z", permissions: null },
  { name: "build.sh", path: "/home/pi/build.sh", isDirectory: false, size: 1024, modified: "2026-02-08T16:45:00Z", permissions: null },
  { name: "README.md", path: "/home/pi/README.md", isDirectory: false, size: 2048, modified: "2026-02-07T09:15:00Z", permissions: null },
  { name: "config.json", path: "/home/pi/config.json", isDirectory: false, size: 512, modified: "2026-02-06T11:30:00Z", permissions: null },
];
