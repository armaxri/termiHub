/**
 * The `mobaxtermImport` scenario of the rendered visual checks (#4850): a
 * discovered MobaXterm configuration whose preview mixes importable sessions
 * (with and without notes, nested folders, long names) and skipped ones, so the
 * import dialog renders every row kind. All data is synthetic.
 */

/** `discover_mobaxterm_configs`: one installed-edition configuration. */
export const MOBAXTERM_CANDIDATES = [
  {
    path: "C:\\Users\\visual\\AppData\\Roaming\\MobaXterm\\MobaXterm.ini",
    source: "installed",
  },
];

/** `preview_mobaxterm_import`: one session of each row kind. */
export const MOBAXTERM_PREVIEW = {
  sourcePath: MOBAXTERM_CANDIDATES[0].path,
  encoding: "windows-1252",
  sessions: [
    {
      key: "moba-0",
      name: "Lab router",
      folderPath: [],
      sessionType: "SSH",
      target: "admin@10.0.0.1",
      connectionType: "ssh",
      settings: { host: "10.0.0.1", port: 22, username: "admin", authMethod: "password" },
      notes: [],
    },
    {
      key: "moba-1",
      name: "Build server behind the bastion with a rather long session name",
      folderPath: ["Datacenter", "Build farm"],
      sessionType: "SSH",
      target: "ci@build.example.com:2222",
      connectionType: "ssh",
      settings: { host: "build.example.com", port: 2222, username: "ci", authMethod: "key" },
      notes: ["The command run at login was not imported."],
    },
    {
      key: "moba-2",
      name: "Switch console",
      folderPath: ["Lab"],
      sessionType: "Serial",
      target: "COM3 @ 9600",
      connectionType: "serial",
      settings: { port: "COM3", baudRate: "9600" },
      notes: [],
    },
    {
      key: "moba-3",
      name: "Old switch",
      folderPath: ["Lab"],
      sessionType: "Telnet",
      target: "192.0.2.10",
      connectionType: "telnet",
      settings: { host: "192.0.2.10", port: 23 },
      notes: [],
    },
    {
      key: "moba-4",
      name: "Team wiki",
      folderPath: [],
      sessionType: "Browser",
      target: "",
      skipReason: "termiHub has no Browser connection type.",
      notes: [],
    },
    {
      key: "moba-5",
      name: "Broken entry",
      folderPath: ["Lab"],
      sessionType: "Unknown",
      target: "",
      skipReason: "The session line is truncated or malformed.",
      notes: [],
    },
  ],
};
