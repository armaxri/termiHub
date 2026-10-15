/**
 * Tests for the install dialog's access diff against the installed copy
 * (#4418): an update or re-install shows what it asks for that the installed
 * version did not (prominently) and what it no longer requests (secondary);
 * a no-op update and a fresh install show no diff.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import React from "react";
import { useAppStore } from "@/store/appStore";
import type { PluginAccessDiff, PluginManifest, PluginTrustInfo } from "@/types/plugin";
import { withTooltip } from "@/test/tooltip";
import { PluginInstallDialog } from "./PluginInstallDialog";
import { describeConnectionPolicy, describeDiffPath } from "./pluginAccessDiff";

function manifest(version = "1.2.0"): PluginManifest {
  return {
    id: "k8s",
    name: "Kubernetes Exec",
    version,
    author: "k8s-contrib",
    description: "desc",
    license: "MIT",
    apiVersion: "1.0",
    platforms: ["macos"],
    permissions: ["terminal", "filesystem"],
    extensions: {
      terminalBackend: {
        connectionType: "k8s-exec",
        displayName: "Kubernetes Exec",
        configSchema: {},
      },
    },
  };
}

const TRUST: PluginTrustInfo = {
  level: "untrusted",
  warning: "unverified",
  keyId: null,
  publisher: null,
  publicKey: null,
  requiresAcceptance: true,
  isBlocked: false,
};

function emptyDiff(): PluginAccessDiff {
  return {
    added: { permissions: [], filesystemPaths: [] },
    removed: { permissions: [], filesystemPaths: [] },
    connectionPolicy: null,
  };
}

/** An update that adds and removes one of each kind. */
function fullDiff(): PluginAccessDiff {
  return {
    added: {
      permissions: ["filesystem"],
      filesystemPaths: [
        { declared: "${home}/.kube", folder: "/Users/alice/.kube" },
        { declared: "/var/log/app/", folder: "/var/log/app" },
      ],
    },
    removed: {
      permissions: ["network"],
      filesystemPaths: [{ declared: "${config}/k8s", folder: "/Users/alice/.config/k8s" }],
    },
    connectionPolicy: { before: null, after: { allowLocalNetwork: true, maxConnections: 8 } },
  };
}

let container: HTMLDivElement;
let root: Root;

function render(props: {
  version?: string;
  installedVersion?: string;
  accessDiff?: PluginAccessDiff;
}) {
  act(() =>
    root.render(
      withTooltip(
        React.createElement(PluginInstallDialog, {
          filePath: "/tmp/k8s.termihub-plugin",
          manifest: manifest(props.version),
          trust: TRUST,
          installedVersion: props.installedVersion,
          accessDiff: props.accessDiff,
          onClose: vi.fn(),
        })
      )
    )
  );
}

const q = (testId: string) => document.querySelector(`[data-testid="${testId}"]`);
const texts = (selector: string) =>
  Array.from(document.querySelectorAll(selector)).map((el) => el.textContent ?? "");

describe("PluginInstallDialog access diff (#4418)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows what an update adds prominently and what it removes as secondary", () => {
    render({ installedVersion: "1.0.0", accessDiff: fullDiff() });

    const banner = q("plugin-install-access-more")!;
    expect(banner.textContent).toContain("This update asks for more access");
    expect(banner.textContent).toContain("installed version 1.0.0");
    // Added: permission, both folder forms, and the connection policy.
    expect(banner.querySelector('[data-testid="plugin-install-access-added"]')).not.toBeNull();
    expect(q("plugin-install-access-added-perm-filesystem")).not.toBeNull();
    expect(texts('[data-testid="plugin-install-access-added-path"]')).toEqual([
      "Folder — ${home}/.kube → /Users/alice/.kube",
      "Folder — /var/log/app",
    ]);
    expect(q("plugin-install-access-added-policy")!.textContent).toContain(
      "host defaults → max 8 connections, local network allowed"
    );

    // Removed: outside the banner, as a secondary list.
    const removed = q("plugin-install-access-removed")!;
    expect(banner.contains(removed)).toBe(false);
    expect(q("plugin-install-access-removed-perm-network")).not.toBeNull();
    expect(texts('[data-testid="plugin-install-access-removed-path"]')).toEqual([
      "Folder — ${config}/k8s → /Users/alice/.config/k8s",
    ]);
    expect(q("plugin-install-access-removed-policy")).toBeNull();

    expect(q("plugin-install-version")!.textContent).toBe("1.0.0 → 1.2.0");
    // The consent itself is unchanged: the same install action is offered.
    expect(q("plugin-install-confirm")).not.toBeNull();
  });

  it("shows no diff for a no-op update", () => {
    render({ installedVersion: "1.0.0", accessDiff: emptyDiff() });
    expect(q("plugin-install-access-diff")).toBeNull();
    expect(q("plugin-install-access-more")).toBeNull();
    expect(q("plugin-install-version")!.textContent).toBe("1.0.0 → 1.2.0");
  });

  it("shows no diff for a fresh install", () => {
    render({});
    expect(q("plugin-install-access-diff")).toBeNull();
    expect(q("plugin-install-version")!.textContent).toBe("1.2.0");
  });

  it("covers a re-install of the same version", () => {
    render({ version: "1.2.0", installedVersion: "1.2.0", accessDiff: fullDiff() });
    expect(q("plugin-install-access-more")!.textContent).toContain(
      "This reinstall asks for more access"
    );
    expect(q("plugin-install-version")!.textContent).toBe("1.2.0");

    act(() => root.unmount());
    root = createRoot(container);
    render({ version: "1.2.0", installedVersion: "1.2.0", accessDiff: emptyDiff() });
    expect(q("plugin-install-access-diff")).toBeNull();
  });

  it("lists only removals without the more-access banner", () => {
    const diff = emptyDiff();
    diff.removed.permissions = ["network"];
    diff.connectionPolicy = { before: { maxConnections: 4 }, after: null };
    render({ installedVersion: "1.0.0", accessDiff: diff });
    expect(q("plugin-install-access-diff")).not.toBeNull();
    expect(q("plugin-install-access-more")).toBeNull();
    expect(q("plugin-install-access-removed-perm-network")).not.toBeNull();
    expect(q("plugin-install-access-removed-policy")!.textContent).toContain(
      "max 4 connections (back to host defaults)"
    );
  });

  it("flags a changed policy the update still declares as more access", () => {
    const diff = emptyDiff();
    diff.connectionPolicy = { before: { maxConnections: 2 }, after: { maxConnections: 8 } };
    render({ installedVersion: "1.0.0", accessDiff: diff });
    expect(q("plugin-install-access-more")).not.toBeNull();
    expect(q("plugin-install-access-added-policy")!.textContent).toContain(
      "max 2 connections → max 8 connections"
    );
    expect(q("plugin-install-access-removed")).toBeNull();
  });

  it("hides the diff for a blocked (tampered) package", () => {
    act(() =>
      root.render(
        withTooltip(
          React.createElement(PluginInstallDialog, {
            filePath: "/tmp/k8s.termihub-plugin",
            manifest: manifest(),
            trust: { ...TRUST, level: "tampered", isBlocked: true },
            installedVersion: "1.0.0",
            accessDiff: fullDiff(),
            onClose: vi.fn(),
          })
        )
      )
    );
    expect(q("plugin-install-access-diff")).toBeNull();
  });
});

describe("access diff presentation (#4418)", () => {
  it("describes connection policies in a few words", () => {
    expect(describeConnectionPolicy(null)).toBe("host defaults");
    expect(describeConnectionPolicy({})).toBe("host defaults");
    expect(
      describeConnectionPolicy({
        maxConnections: 3,
        connectTimeoutMs: 500,
        allowLocalNetwork: true,
      })
    ).toBe("max 3 connections, 500 ms connect timeout, local network allowed");
  });

  it("shows the declared placeholder form next to the resolved folder", () => {
    expect(describeDiffPath({ declared: "${home}/x", folder: "/home/a/x" })).toBe(
      "${home}/x → /home/a/x"
    );
    expect(describeDiffPath({ declared: "/data/a/", folder: "/data/a" })).toBe("/data/a");
  });
});
