/**
 * The `mobaxtermImport` scenario of the rendered visual checks (#4850): a
 * discovered MobaXterm configuration whose preview mixes importable sessions
 * (with and without notes, nested folders, long names) and skipped ones, so the
 * import dialog renders every row kind, plus a file-level note (#4854). All
 * data is synthetic.
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
      target: "netops@10.0.0.1",
      connectionType: "ssh",
      settings: { host: "10.0.0.1", port: 22, username: "netops", authMethod: "password" },
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
  hostKeys: [
    {
      id: "ssh-ed25519@22:203.0.113.5",
      host: "203.0.113.5",
      port: 22,
      keyType: "ssh-ed25519",
      fingerprint: "SHA256:D0k/zRUCvz3ysFQzAG0q7hQl2n/TE2fiVuLyLO5vJFw",
      knownHostsLine: "203.0.113.5 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKDTD2Gcc7Keuye43",
      status: "new",
    },
    {
      id: "rsa2@2222:server.example.com",
      host: "server.example.com",
      port: 2222,
      keyType: "ssh-rsa",
      fingerprint: "SHA256:uyN+WW7iOMrYqwASFPd2J96MZycl8gO/tDTD238RSAY",
      knownHostsLine: "[server.example.com]:2222 ssh-rsa AAAAB3NzaC1yc2E",
      status: "conflict",
      reason: "termiHub already trusts a different key for this host; it is not replaced.",
    },
    {
      id: "dss@22:192.0.2.8",
      host: "192.0.2.8",
      port: 22,
      status: "invalid",
      reason: "DSA host keys are obsolete and not supported.",
    },
  ],
  notes: [
    "MobaXterm's global appearance settings ([Font], [Colors]) were not imported; set termiHub's font, colours and cursor under Settings → Appearance.",
  ],
};
