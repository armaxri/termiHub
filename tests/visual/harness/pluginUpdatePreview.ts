/**
 * The `pluginUpdate` scenario of the rendered visual checks (#4418): an update
 * package whose install preview carries an access diff against the installed
 * copy, so the install dialog renders its "asks for more access" banner and the
 * list of access the update no longer requests.
 */

/** The package path the mocked file picker returns. */
export const PLUGIN_UPDATE_PACKAGE = "/home/visual/Downloads/kube-exec-2.0.0.termihub-plugin";

/** `preview_plugin`: a native plugin update that adds and removes access. */
export const PLUGIN_UPDATE_PREVIEW = {
  manifest: {
    id: "kube-exec",
    name: "Kubernetes Exec",
    version: "2.0.0",
    author: "k8s-contrib",
    description: "Open shells in Kubernetes pods",
    license: "MIT",
    apiVersion: "1.1",
    platforms: ["linux", "macos", "windows"],
    permissions: ["terminal", "network", "filesystem"],
    filesystemPaths: ["${home}/.kube", "/var/log/kube-exec-with-a-long-folder-name/"],
    connectionPolicy: { maxConnections: 16, allowLocalNetwork: true },
    extensions: {
      terminalBackend: {
        connectionType: "kube-exec",
        displayName: "Kubernetes Exec",
        configSchema: {},
      },
    },
  },
  hostPlatform: "x86_64-unknown-linux-gnu",
  platformSupported: true,
  resolvedFilesystemPaths: [{ declared: "${home}/.kube", resolved: "/home/visual/.kube" }],
  installedVersion: "1.4.2",
  accessDiff: {
    added: {
      permissions: ["filesystem"],
      filesystemPaths: [
        { declared: "${home}/.kube", folder: "/home/visual/.kube" },
        {
          declared: "/var/log/kube-exec-with-a-long-folder-name/",
          folder: "/var/log/kube-exec-with-a-long-folder-name",
        },
      ],
    },
    removed: {
      permissions: ["settings"],
      filesystemPaths: [
        { declared: "${config}/kube-exec", folder: "/home/visual/.config/kube-exec" },
      ],
    },
    connectionPolicy: {
      before: { maxConnections: 4 },
      after: { maxConnections: 16, allowLocalNetwork: true },
    },
  },
};

/** `assess_plugin_trust`: a signed package from a not-yet-trusted key. */
export const PLUGIN_UPDATE_TRUST = {
  level: "signed",
  warning: "Signed by a publisher you have not trusted yet.",
  keyId: "sha256:3f1c9a0b7d2e4f6a8c0b1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a",
  publisher: null,
  publicKey: "AAAA",
  requiresAcceptance: true,
  isBlocked: false,
};
